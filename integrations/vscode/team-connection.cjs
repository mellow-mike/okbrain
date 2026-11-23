'use strict';

const tokenPattern = /^okbp_[a-zA-Z0-9_-]{43}$/;
const projectPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const requestPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const sessionPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const readActions = new Set(['presets', 'runs']);
const postActions = new Set(['preview', 'run', 'inspect', 'source-inspect', 'branch-comparison-inspect', 'cancel', 'resume', 'review']);
const previewFields = new Set(['source', 'query', 'projects', 'profile', 'tokenBudget']);
const runFields = new Set([...previewFields, 'session', 'requestId', 'prompt', 'previewId', 'approved', 'approvedSourceLookup']);
const runStatuses = new Set(['running', 'interrupted', 'done', 'unanswered', 'failed', 'cancelled']);

class TeamConnectionError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TeamConnectionError';
    this.status = status;
    this.statusCode = status;
  }
}

function teamUrl(value) {
  if (typeof value === 'string' && value.length <= 256) {
    try {
      const url = new URL(value);
      const withoutSlash = value.endsWith('/') ? value.slice(0, -1) : value;
      const suppliedOrigin = withoutSlash.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
      const explicitDefaultPort = !url.port && suppliedOrigin === `${url.origin}:443`;
      if (url.protocol === 'https:' && (suppliedOrigin === url.origin || explicitDefaultPort)) return url;
    } catch { /* Report invalid input without echoing it. */ }
  }
  throw new TeamConnectionError('Enter the HTTPS address from the okbrain team workspace without a path, credentials, query, or fragment.');
}

function isTeamToken(value) {
  return typeof value === 'string' && value.length === 48 && tokenPattern.test(value);
}

function isProjectId(value) {
  return typeof value === 'string' && value.length === 36 && projectPattern.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRunIdentity(value) {
  return isRecord(value) && typeof value.session === 'string' && sessionPattern.test(value.session) &&
    typeof value.requestId === 'string' && requestPattern.test(value.requestId);
}

function isBranchComparisonSide(side, projectId, expected) {
  return isRunIdentity(side) && (!expected || (side.session === expected.session && side.requestId === expected.requestId)) &&
    side.status === 'done' && (side.review === null || side.review === 'accepted' || side.review === 'changes_requested') &&
    (side.task === undefined || typeof side.task === 'string') &&
    typeof side.answer?.text === 'string' && typeof side.answer.truncated === 'boolean' &&
    side.report?.version === 1 && side.report.projectId === projectId && side.report.session === side.session &&
    side.report.request?.requestId === side.requestId && side.report.runStatus === side.status;
}

function isText(value, bytes) {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= bytes;
}

function isScope(value) {
  return isText(value, 4096) && !/[\\:\x00-\x1f\x7f]/.test(value) && (value === '.' ||
    value.split('/').every((part) => part && part !== '.' && part !== '..'));
}

function invalidResponse() {
  return new TeamConnectionError('The HTTPS endpoint returned an invalid okbrain team workspace response.');
}

function projectView(project) {
  if (!isRecord(project) || !isProjectId(project.id) || !isText(project.title, 128) || !isText(project.provider, 24) ||
      !isText(project.model, 256) || !Array.isArray(project.scopes) || project.scopes.length < 1 ||
      project.scopes.length > 8 || !project.scopes.every(isScope)) throw invalidResponse();
  return {
    id: project.id,
    title: project.title,
    provider: project.provider,
    model: project.model,
    scopes: project.scopes,
    ...(isText(project.providerLabel, 128) ? { providerLabel: project.providerLabel } : {}),
    ...(isText(project.thinking, 12) ? { thinking: project.thinking } : {}),
    ...(project.credential === 'project' || project.credential === 'missing' ? { credential: project.credential } : {}),
  };
}

function requestError(status) {
  switch (status) {
    case 401: return new TeamConnectionError('The coding project token is invalid, expired, or revoked. Ask the project operator for a new token.', status);
    case 403: return new TeamConnectionError('The team workspace denied access to this project action.', status);
    case 404: return new TeamConnectionError('The team workspace could not find that project item.', status);
    case 409: return new TeamConnectionError('The team workspace could not complete this action in the current state. Refresh the request or preview and try again.', status);
    case 410: return new TeamConnectionError('The requested coding transcript has expired.', status);
    default: return new TeamConnectionError(`The team workspace returned HTTP ${status}.`, status);
  }
}

function validateResult(action, result, projectId, data) {
  const validRun = (run) => isRecord(run) && run.project === projectId && typeof run.id === 'string' && requestPattern.test(run.id) &&
    typeof run.session === 'string' && sessionPattern.test(run.session) && runStatuses.has(run.status) &&
    (!data || (run.id === data.requestId && run.session === data.session));
  switch (action) {
    case 'presets':
      if (!Array.isArray(result?.presets)) throw invalidResponse();
      break;
    case 'preview':
      if (result?.source !== 'repository' || !isText(result.manifest?.id, 128) || !Array.isArray(result.excerpts)) throw invalidResponse();
      break;
    case 'runs':
      if (!Array.isArray(result) || !result.every(validRun)) throw invalidResponse();
      break;
    case 'inspect':
      if (!validRun(result?.run)) throw invalidResponse();
      break;
    case 'source-inspect':
      if (result !== null && (typeof result?.prompt !== 'string' || !Array.isArray(result.groups))) throw invalidResponse();
      break;
    case 'branch-comparison-inspect':
      if (!isBranchComparisonSide(result?.original, projectId) || !isBranchComparisonSide(result?.alternative, projectId, data) ||
          result.original.session === result.alternative.session) throw invalidResponse();
      break;
    default:
      if (!validRun(result)) throw invalidResponse();
  }
  return result;
}

async function connectTeam(origin, token, projectId) {
  const url = teamUrl(origin);
  if (!isTeamToken(token)) throw new TeamConnectionError('Enter an okbrain coding project token.');
  if (projectId !== undefined && !isProjectId(projectId)) throw new TeamConnectionError('Choose a valid coding project.');

  const trustedOrigin = url.origin;
  async function request(path, data, timeoutMs) {
    const target = new URL(`/api/coding${path}`, trustedOrigin);
    let body;
    try { body = data === undefined ? undefined : JSON.stringify(data); }
    catch { throw new TeamConnectionError('The coding project request could not be encoded.'); }
    if (body?.includes(token)) throw new TeamConnectionError('Remove the coding project token from the request text.');

    let response;
    try {
      response = await fetch(target, {
        method: data === undefined ? 'GET' : 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new TeamConnectionError('Could not reach the okbrain team workspace. Check its HTTPS address, certificate, and availability.');
    }
    if (response.redirected || (response.url && response.url !== target.href) || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => {});
      throw new TeamConnectionError('The okbrain team workspace must serve its API directly over HTTPS.');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw requestError(response.status);
    }
    const payload = await response.json().catch(() => undefined);
    if (!isRecord(payload) || !Object.hasOwn(payload, 'result') || JSON.stringify(payload).includes(token)) throw invalidResponse();
    return payload.result;
  }

  const projects = await request('/projects', undefined, 2500);
  if (!Array.isArray(projects) || projects.length !== 1) throw invalidResponse();
  const project = projectView(projects[0]);
  if (projectId !== undefined && project.id !== projectId) {
    throw new TeamConnectionError('The token belongs to a different project than this saved team connection.');
  }

  const boundProjectId = project.id;
  const prefix = `/projects/${boundProjectId}/`;
  async function api(path, data, timeoutMs = 30_000) {
    const action = typeof path === 'string' && path.startsWith(prefix) ? path.slice(prefix.length) : '';
    if (data === undefined ? !readActions.has(action) : !postActions.has(action) || !isRecord(data)) {
      throw new TeamConnectionError('Choose a supported action on the connected coding project.');
    }
    if (action === 'branch-comparison-inspect' && (!isRunIdentity(data) || Object.keys(data).length !== 2)) {
      throw new TeamConnectionError('Choose one saved alternative run to compare.');
    }
    if (action === 'preview' || action === 'run') {
      const fields = action === 'preview' ? previewFields : runFields;
      if (data.source !== 'repository' || Object.keys(data).some((key) => !fields.has(key))) {
        throw new TeamConnectionError('Team editor requests must use the project’s server-side repository excerpts.');
      }
    }
    return validateResult(action, await request(path, data, timeoutMs), boundProjectId, data);
  }

  return { url, api, projects: [project], mode: 'team', projectId: boundProjectId };
}

module.exports = { connectTeam, isBranchComparisonSide, isTeamToken, teamUrl, TeamConnectionError };
