import license from "../../gui/fonts/OFL.txt" with { type: "text" };
import literataItalic from "../../gui/fonts/Literata-Italic-VF.woff2" with { type: "file" };
import literata from "../../gui/fonts/Literata-VF.woff2" with { type: "file" };
import recursiveMono from "../../gui/fonts/RecursiveMono-VF.woff2" with { type: "file" };
import recursiveSans from "../../gui/fonts/RecursiveSans-VF.woff2" with { type: "file" };
import inter from "../../gui/fonts/Inter-Latin.woff2" with { type: "file" };
import jetBrainsMono from "../../gui/fonts/JetBrainsMono-Latin.woff2" with { type: "file" };
import interLicense from "../../gui/fonts/Inter-OFL.txt" with { type: "text" };
import jetBrainsMonoLicense from "../../gui/fonts/JetBrainsMono-OFL.txt" with { type: "text" };

const faces = [
  { family: "Recursive Sans", name: "RecursiveSans-VF", file: recursiveSans, weight: "300 800" },
  { family: "Recursive Mono", name: "RecursiveMono-VF", file: recursiveMono, weight: "400 700" },
  { family: "Literata", name: "Literata-VF", file: literata, weight: "400 700" },
  { family: "Literata", name: "Literata-Italic-VF", file: literataItalic, weight: "400 700", style: "italic" },
].map((face) => ({ ...face, path: `/gui/fonts/${face.name}.woff2` }));

function fontRule(face: (typeof faces)[number], url: string): string {
  return `@font-face { font-family: "${face.family}"; src: url("${url}") format("woff2"); ` +
    `font-weight: ${face.weight}; font-style: ${face.style ?? "normal"}; font-display: block; }`;
}

const hostedFaces = [...faces,
  { family: "Inter", name: "Inter-Latin", file: inter, weight: "100 900", path: "/gui/fonts/Inter-Latin.woff2" },
  { family: "JetBrains Mono", name: "JetBrainsMono-Latin", file: jetBrainsMono, weight: "100 800", path: "/gui/fonts/JetBrainsMono-Latin.woff2" },
];
export const fontAssets = hostedFaces.map(({ path, file }) => [path, [Bun.file(file), "font/woff2"]] as const);
export const hostedFontCss = [license, interLicense, jetBrainsMonoLicense].map((notice) => `/* ${notice.trim()} */`).concat(
  hostedFaces.map((face) => fontRule(face, face.path)),
).join("\n");

export async function embeddedFontCss(): Promise<string> {
  const rules = await Promise.all(faces.map(async (face) => {
    const base64 = Buffer.from(await Bun.file(face.file).arrayBuffer()).toString("base64");
    return fontRule(face, `data:font/woff2;base64,${base64}`);
  }));
  return `/* ${license.trim()} */\n${rules.join("\n")}`;
}
