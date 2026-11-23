import ICAL from "ical.js";
import { parseHTML } from "linkedom";
import PostalMime from "postal-mime";

export interface OfflineItem {
  key: string;
  title: string;
  details: string[];
  text: string;
}

const label = (value: string | undefined, limit = 300): string =>
  (value ?? "").replace(/[\s\p{Cc}]+/gu, " ").trim().slice(0, limit);
const bodyText = (value: string): string => value.replace(/\r\n?/g, "\n")
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();

function readableHtml(html: string): string {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  for (const node of document.querySelectorAll("script,style,template,head,iframe,object,embed,svg,video,audio")) node.remove();
  for (const node of document.querySelectorAll("br,p,div,li,tr,h1,h2,h3,h4,blockquote")) node.after(document.createTextNode("\n"));
  return document.body.textContent ?? "";
}

export async function readMail(raw: Uint8Array | string, path: string): Promise<OfflineItem | undefined> {
  const email = await PostalMime.parse(raw, {
    forceRfc822Attachments: true, maxNestingDepth: 16, maxPartCount: 128, maxHeadersSize: 128 * 1024,
  });
  if (!email.headers.some(({ key }) => ["from", "subject", "date", "message-id"].includes(key))) return undefined;
  const text = bodyText(email.text?.trim() || (email.html ? readableHtml(email.html) : ""));
  if (!text) return undefined;
  const sender = email.from ? label(email.from.name) : "";
  const address = label(email.from?.address);
  const from = sender && address ? `${sender} <${address}>` : sender || address;
  const date = label(email.date);
  return {
    key: label(email.messageId, 1024) || path,
    title: label(email.subject, 140) || "Untitled email",
    details: [...(from ? [`From: ${from}`] : []), ...(date ? [`Date: ${date}`] : [])],
    text,
  };
}

function propertyString(event: ICAL.Component, key: string): string {
  const value = event.getFirstPropertyValue(key);
  return typeof value === "string" ? value : "";
}

function eventTime(event: ICAL.Component, key: string): string {
  const property = event.getFirstProperty(key);
  const time = property?.getFirstValue();
  if (!(time instanceof ICAL.Time)) return "";
  const zone = property?.getParameter("tzid");
  return `${time.toString()}${typeof zone === "string" ? ` (${label(zone)})` : ""}`;
}

export function readCalendar(text: string, rowLimit: number): (OfflineItem | undefined)[] {
  const parsed = ICAL.parse(text.replace(/^\uFEFF/, ""));
  const calendars: ICAL.Component[] = (typeof parsed[0] === "string" ? [parsed] : parsed)
    .map((calendar: unknown[]) => new ICAL.Component(calendar));
  if (!calendars.length || calendars.some(({ name }) => name !== "vcalendar")) throw new Error("Expected an iCalendar export.");
  const rows: (OfflineItem | undefined)[] = [];
  for (const calendar of calendars) {
    const method = label(propertyString(calendar, "method"));
    for (const event of calendar.getAllSubcomponents("vevent")) {
      if (rows.length === rowLimit) break;
      const uid = propertyString(event, "uid").trim();
      if (!uid || uid.length > 1024 || /\p{Cc}/u.test(uid)) { rows.push(undefined); continue; }
      const recurrence = eventTime(event, "recurrence-id");
      if (event.hasProperty("recurrence-id") && !recurrence) { rows.push(undefined); continue; }
      const rule = event.getFirstProperty("rrule")?.getFirstValue();
      const details = [
        ["Starts", eventTime(event, "dtstart")], ["Ends", eventTime(event, "dtend")],
        ["Duration", event.getFirstPropertyValue("duration")?.toString() ?? ""],
        ["Location", label(propertyString(event, "location"))], ["Status", label(propertyString(event, "status"))],
        ["Calendar method", method], ["Recurrence exception", recurrence],
        ["Recurrence rule", rule instanceof ICAL.Recur ? label(rule.toString(), 512) : ""],
      ].filter(([, value]) => value).map(([name, value]) => `${name}: ${value}`);
      for (const property of [...event.getAllProperties("rdate"), ...event.getAllProperties("exdate")])
        details.push(bodyText(property.toICALString()));
      rows.push({ key: JSON.stringify([uid, recurrence]), title: label(propertyString(event, "summary"), 140) || "Untitled event",
        details, text: bodyText(propertyString(event, "description")) });
    }
    if (rows.length === rowLimit) break;
  }
  return rows;
}
