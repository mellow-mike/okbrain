'use strict';

const vscode = require('vscode');
const { randomUUID } = require('node:crypto');
const { connect, projectFile, matchesProjectWorkspace } = require('./connection.cjs');
const { taskProgressLines } = require('./run-progress.cjs');
const { teamUrl, isTeamToken, connectTeam, isBranchComparisonSide } = require('./team-connection.cjs');

const savedSourceScheme = 'okbrain-saved-source';
const teamSecret = 'okbrain.team.connection';
const openingSources = new Map();
let inspection = 0;
let requestReview = 0;
let workspaceRevision = 0;
let editorRevision = 0;
let teamRevision = 0;
let teamChange = 0;
let secretWrites = Promise.resolve();

function trustedEditor() {
  return vscode.workspace.isTrusted && !vscode.env.remoteName;
}

function changeTeamSecret(change, write) {
  const update = secretWrites.then(async () => {
    if (change !== teamChange) return false;
    await write();
    return change === teamChange;
  });
  secretWrites = update.catch(() => {});
  return update;
}

async function addTeamConnection(secrets) {
  const change = ++teamChange;
  ++teamRevision;
  const address = await vscode.window.showInputBox({ prompt: 'Team workspace HTTPS address', ignoreFocusOut: true,
    validateInput: (value) => {
      try { teamUrl(value); return null; }
      catch { return 'Enter the team workspace HTTPS origin without a path, query, or fragment.'; }
    } });
  if (address === undefined || change !== teamChange) return;
  const origin = teamUrl(address).origin;
  const token = await vscode.window.showInputBox({ prompt: `Project token for ${origin}`, password: true, ignoreFocusOut: true,
    validateInput: (value) => isTeamToken(value.trim()) ? null : 'Enter the project token supplied by the team operator.' });
  if (token === undefined || change !== teamChange || !trustedEditor()) return;
  const credential = token.trim();
  const { projectId, projects } = await connectTeam(origin, credential);
  if (!trustedEditor()) return;
  const stored = await changeTeamSecret(change, async () => {
    if (!trustedEditor()) throw new Error('Open a trusted local editor to connect to a team workspace.');
    await secrets.store(teamSecret, JSON.stringify({ origin, projectId, token: credential }));
    ++teamRevision;
  });
  if (stored) await vscode.window.showInformationMessage(`Connected to ${projects[0].title} at ${origin}.`);
}

async function removeTeamConnection(secrets) {
  const change = ++teamChange;
  ++teamRevision;
  const removed = await changeTeamSecret(change, async () => {
    await secrets.delete(teamSecret);
    ++teamRevision;
  });
  if (removed) await vscode.window.showInformationMessage('Disconnected from the team workspace in this editor.');
}

function teamBinding(saved) {
  if (!saved) throw new Error('Choose okbrain: Connect to Team Workspace first.');
  try {
    const binding = JSON.parse(saved);
    if (teamUrl(binding.origin).origin !== binding.origin || !isTeamToken(binding.token) ||
        typeof binding.projectId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(binding.projectId)) throw new Error();
    return binding;
  } catch { throw new Error('Reconnect to the team workspace to refresh its saved connection.'); }
}

async function openTeamSignIn(secrets) {
  const revision = teamRevision;
  const saved = await secrets.get(teamSecret);
  if (revision !== teamRevision || !trustedEditor()) return;
  return vscode.env.openExternal(vscode.Uri.parse(teamBinding(saved).origin + '/'));
}

async function openTeamConnection(secrets) {
  const revision = teamRevision;
  const current = () => revision === teamRevision && trustedEditor();
  const saved = await secrets.get(teamSecret);
  if (!current()) return undefined;
  const binding = teamBinding(saved);
  const isBound = async () => current() && (await secrets.get(teamSecret)) === saved && current();
  const connection = await connectTeam(binding.origin, binding.token, binding.projectId);
  if (!await isBound() || !current()) return undefined;
  return { ...connection, current, isBound, async api(path, data, timeoutMs) {
    if (!await isBound() || !current()) throw new Error('The team connection changed. Reopen this action.');
    const result = await connection.api(path, data, timeoutMs);
    if (!await isBound() || !current()) throw new Error('The team connection changed. Reopen this action.');
    return result;
  } };
}

function pathFor(project, action) {
  return `/projects/${encodeURIComponent(project.id)}/${action}`;
}

function openWeb(connection, project, run, section) {
  const target = new URL(connection.url);
  if (connection.mode === 'team') return vscode.env.openExternal(vscode.Uri.parse(target.origin + '/'));
  const folder = vscode.workspace.workspaceFolders?.find((item) => item.uri.scheme === 'file');
  target.hash = project ? `coding/${encodeURIComponent(project.id)}` : folder
    ? `coding/${encodeURIComponent(`workspace=${folder.uri.fsPath}`)}` : 'coding';
  if (project && run) {
    if (section === 'alternative-branch') {
      target.hash += `?${new URLSearchParams({ session: run.session, request: run.id })}`;
    } else {
      target.hash += `/${section}/${encodeURIComponent(run.session)}/${encodeURIComponent(run.id)}`;
    }
  }
  return vscode.env.openExternal(vscode.Uri.parse(target.toString()));
}

async function chooseProject(connection, choices) {
  if (choices.length === 1) return choices[0];
  if (!choices.length) {
    const action = await vscode.window.showInformationMessage('Register a project in okbrain to continue.', 'Open Coding Workspace');
    if (action) await openWeb(connection);
    return undefined;
  }
  return vscode.window.showQuickPick(choices, { placeHolder: 'Choose an okbrain project', ignoreFocusOut: true });
}

async function showText(content) {
  const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content });
  return vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
}

async function showReadOnlyText(title, content, isCurrent) {
  const uri = vscode.Uri.from({ scheme: savedSourceScheme, path: `/${title}.txt`, query: randomUUID() });
  const key = uri.toString();
  openingSources.set(key, content);
  try {
    let document = await vscode.workspace.openTextDocument(uri);
    if (!isCurrent()) return;
    if (document.languageId !== 'plaintext') document = await vscode.languages.setTextDocumentLanguage(document, 'plaintext');
    if (!isCurrent()) return;
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
    return document;
  } finally {
    openingSources.delete(key);
  }
}

async function showSavedRequestSource(connection, project, identity, isCurrent) {
  let source;
  try {
    source = await connection.api(pathFor(project, 'source-inspect'), identity);
  } catch (error) {
    if (isCurrent()) throw error;
    return;
  }
  if (!isCurrent()) return;
  if (!source) return vscode.window.showInformationMessage('No saved request source is available.');

  const lines = [project.title, `Session: ${identity.session}`, `Request: ${identity.requestId}`, '', 'Saved task', source.prompt];
  if (source.guidance) lines.push('', 'Project guidance', source.guidance);
  if (!source.groups.length) lines.push('', 'No source files were included in this request.');
  for (const group of source.groups) {
    if (group.label) lines.push('', group.label);
    for (const file of group.files) {
      const range = file.startLine === undefined ? '' : `:${file.startLine}–${file.endLine}`;
      lines.push('', file.path + range, file.text);
    }
  }
  await showReadOnlyText('Saved request source', lines.join('\n'), isCurrent);
}

function comparisonLines(label, side) {
  const { request } = side.report;
  const files = request.repositoryContext?.files ?? request.files;
  const evidence = Array.isArray(files) ? files.flatMap((file) => {
    if (typeof file?.path !== 'string') return [];
    const range = Number.isSafeInteger(file.startLine) && Number.isSafeInteger(file.endLine) ? `:${file.startLine}–${file.endLine}` : '';
    return [file.path + range];
  }) : [];
  const usage = [
    ['input', request.usage?.input], ['output', request.usage?.output], ['cache read', request.usage?.cacheRead],
    ['cache write', request.usage?.cacheWrite], ['total', request.usage?.totalTokens],
  ].flatMap(([name, value]) => Number.isSafeInteger(value) && value >= 0 ? [`${value.toLocaleString()} ${name}`] : []);
  return [label, `Session ${side.session} · request ${side.requestId}`,
    `Status ${side.status} · ${side.review?.replaceAll('_', ' ') ?? 'awaiting review'}`,
    ...(usage.length ? ['Request usage (tokens) · ' + usage.join(' · ')] : []),
    ...(evidence.length ? ['', 'Source references', ...evidence] : []),
    ...(side.task === undefined ? [] : ['', 'Saved task', side.task]),
    '', 'Saved answer', side.answer.text || 'No saved answer text.',
    ...(side.answer.truncated ? ['Preview limit reached.'] : []),
  ];
}

async function showBranchComparison(connection, project, identity, original, isCurrent) {
  let comparison;
  try {
    comparison = await connection.api(pathFor(project, 'branch-comparison-inspect'), identity);
  } catch (error) {
    if (isCurrent()) throw error;
    return;
  }
  if (!isCurrent()) return;
  if (!isBranchComparisonSide(comparison?.original, project.id, original) ||
      !isBranchComparisonSide(comparison?.alternative, project.id, identity)) {
    throw new Error('Could not verify the saved comparison for this alternative run. Refresh Run history and try again.');
  }
  const lines = [project.title, '', ...comparisonLines('Original run', comparison.original),
    '', ...comparisonLines('Alternative run', comparison.alternative)];
  await showReadOnlyText('Alternative run comparison', lines.join('\n'), isCurrent);
}

function chooseSession() {
  return vscode.window.showInputBox({ prompt: 'Coding session name', value: 'ide-review', ignoreFocusOut: true,
    validateInput: (input) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(input) ? null : 'Use lowercase letters, digits, hyphens, or underscores.' });
}

async function submitApprovedRequest(connection, project, request, canSubmit) {
  if (!await canSubmit()) return;
  let run;
  try { run = await connection.api(pathFor(project, 'run'), request); }
  catch (error) {
    if (!await canSubmit()) return;
    if ([401, 403, 410].includes(error.status)) throw error;
    const retry = await vscode.window.showErrorMessage(`${error.message} Request ID: ${request.requestId}.`, 'Try Same Request');
    if (retry !== 'Try Same Request' || !await canSubmit()) return;
    run = await connection.api(pathFor(project, 'run'), request);
  }
  const inspect = await vscode.window.showInformationMessage(`Coding request ${run.id} is ${run.status}.`, 'Inspect Request');
  if (inspect) await inspectRun(connection, project, run);
}

function sourceLookupChoice(label) {
  return vscode.window.showQuickPick([{ label: 'Keep source lookup off', enabled: false }, { label, enabled: true }],
    { placeHolder: 'Choose source lookup for this request', ignoreFocusOut: true });
}

async function confirmRequestPreview(connection, project, title, lines, message, draft, canDisplay, canSubmit) {
  const approvedDocument = await showReadOnlyText(title, lines.join('\n'), canDisplay);
  if (!approvedDocument || !await canSubmit() || vscode.window.activeTextEditor?.document !== approvedDocument) return;
  const approvedEditorRevision = editorRevision;
  const canConfirm = async () => await canSubmit() && editorRevision === approvedEditorRevision &&
    vscode.window.activeTextEditor?.document === approvedDocument;
  const send = await vscode.window.showInformationMessage(message, 'Send Request');
  if (send !== 'Send Request') return;
  await submitApprovedRequest(connection, project, { ...draft, requestId: `ide-${randomUUID()}`, approved: true }, canConfirm);
}

async function runActiveFile(connection) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') throw new Error('Open a local file first.');
  const document = editor.document;
  if (document.isDirty) throw new Error('Save the active file before previewing the bytes on disk.');
  const version = document.version;
  const filePath = document.uri.fsPath;
  const review = ++requestReview;
  const originalWorkspace = workspaceRevision;
  const originalEditor = editorRevision;
  const current = () => review === requestReview && originalWorkspace === workspaceRevision && trustedEditor();
  const unchangedFile = () => document.uri.fsPath === filePath && document.version === version && !document.isDirty;
  const stillEditingFile = () => current() && unchangedFile() && originalEditor === editorRevision && vscode.window.activeTextEditor === editor;
  const choices = [];
  for (const project of connection.projects) {
    if (!project.workspace) continue;
    const relative = await projectFile(project.workspace, filePath).catch(() => null);
    if (relative) choices.push({ label: project.title, description: relative, project, relative });
  }
  if (!stillEditingFile()) return;
  const choice = await chooseProject(connection, choices);
  if (!choice || !stillEditingFile()) return;

  const prompt = await vscode.window.showInputBox({ prompt: 'What should Pi review or propose?', ignoreFocusOut: true,
    validateInput: (input) => input.trim() && Buffer.byteLength(input) <= 16384 ? null : 'Enter a task up to 16 KiB.' });
  if (!prompt?.trim() || !stillEditingFile()) return;
  const session = await chooseSession();
  if (!session || !stillEditingFile()) return;

  const source = { source: 'files', files: [choice.relative] };
  const preview = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Previewing source locally' },
    () => connection.api(pathFor(choice.project, 'preview'), source));
  if (!stillEditingFile()) return;
  const file = preview?.files?.[0];
  if (preview?.source !== 'files' || typeof preview.id !== 'string' || !/^[a-f0-9]{64}$/u.test(preview.id) || preview.files?.length !== 1 ||
      file?.path !== choice.relative || typeof file.content !== 'string') throw new Error('Could not verify the active file preview.');
  const lookup = await sourceLookupChoice('Allow lookups in the approved file');
  if (!lookup || !stillEditingFile()) return;
  const fileBinding = async () => {
    if (!current() || !unchangedFile()) return false;
    const relative = await projectFile(choice.project.workspace, filePath).catch(() => null);
    return current() && unchangedFile() && relative === choice.relative;
  };
  await confirmRequestPreview(connection, choice.project, 'Active file request preview', [
    `Project: ${choice.project.title}`, `Provider and model: ${choice.project.provider} / ${choice.project.model}`,
    `Session: ${session}`, `Source lookup: ${lookup.enabled ? 'Allowed within the approved file' : 'Off'}`,
    '', 'Task', prompt.trim(), '', `File: ${file.path}`, file.content,
  ], 'Review the task and saved file in the editor. Sending includes active session history.', {
    ...source, session, prompt: prompt.trim(), previewId: preview.id,
    ...(lookup.enabled ? { approvedSourceLookup: true } : {}),
  }, stillEditingFile, fileBinding);
}

function localWorkspaceFolders() {
  return vscode.workspace.workspaceFolders?.filter(({ uri }) => uri.scheme === 'file') ?? [];
}

async function runLocalRepositoryRequest(connection, usePreset) {
  const review = ++requestReview;
  const originalWorkspace = workspaceRevision;
  const isCurrent = () => review === requestReview && originalWorkspace === workspaceRevision && trustedEditor();
  const activeFile = vscode.window.activeTextEditor?.document.uri;
  const folders = localWorkspaceFolders();
  const activePath = activeFile?.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(activeFile)?.uri.fsPath : undefined;
  const candidates = activeFile?.scheme === 'file' ? folders.filter(({ uri }) => uri.fsPath === activePath) : folders;
  const choices = [];
  for (const project of connection.projects) {
    if (!project.workspace) continue;
    for (const { uri } of candidates) {
      if (!await matchesProjectWorkspace(project.workspace, uri.fsPath).catch(() => false)) continue;
      if (activeFile?.scheme === 'file' && !await projectFile(project.workspace, activeFile.fsPath).catch(() => null)) continue;
      choices.push({ label: project.title, description: uri.fsPath, project, workspace: uri.fsPath });
      break;
    }
  }
  if (!isCurrent()) return;
  if (!choices.length) throw new Error('Open the registered project folder to preview a repository request.');
  const choice = await chooseProject(connection, choices);
  if (!choice || !isCurrent()) return;
  const { project, workspace } = choice;
  const confirmWorkspace = async () => {
    if (!isCurrent()) return false;
    const file = vscode.window.activeTextEditor?.document.uri;
    if (!vscode.workspace.isTrusted || vscode.env.remoteName || !localWorkspaceFolders().some(({ uri }) => uri.fsPath === workspace) ||
        (file?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(file)?.uri.fsPath !== workspace) ||
        !await matchesProjectWorkspace(project.workspace, workspace).catch(() => false)) {
      throw new Error('The open workspace changed. Open the registered project and preview the request again.');
    }
    return isCurrent();
  };

  if (!await confirmWorkspace()) return;
  let draft;
  if (usePreset) {
    const { presets } = await connection.api(pathFor(project, 'presets'));
    if (!isCurrent()) return;
    if (!presets.length) return vscode.window.showInformationMessage('This project has no saved request presets.');
    const item = await vscode.window.showQuickPick(presets.map((preset) => ({ label: preset.name, preset })),
      { placeHolder: 'Choose a saved request preset', ignoreFocusOut: true });
    if (!item || !isCurrent()) return;
    const { name, prompt, query, profile } = item.preset;
    draft = { name, prompt, source: { source: 'repository', query, profile } };
  } else draft = await repositoryRequestDraft(project, false);
  if (!draft || !isCurrent()) return;
  const session = await chooseSession();
  if (!session) return;
  await reviewRepositoryRequest(connection, project, { ...draft, session }, isCurrent, confirmWorkspace);
}

function narrowerRepositoryDirectories(scopes, value) {
  if (!value.trim()) return scopes;
  const entries = value.split(',').map((path) => path.trim().replaceAll('\\', '/'));
  if (entries.length > 8 || entries.some((path) => !path || Buffer.byteLength(path) > 4096 || path.startsWith('/') ||
      /[:\x00-\x1f\x7f]/u.test(path) || path.split('/').includes('..'))) return undefined;
  const paths = [...new Set(entries.map((path) => path.split('/').filter((segment) => segment && segment !== '.').join('/') || '.'))];
  return paths.every((path) => scopes.some((scope) => scope === '.' || path === scope || path.startsWith(scope + '/'))) ? paths : undefined;
}

async function repositoryRequestDraft(project, team) {
  const prompt = await vscode.window.showInputBox({ prompt: 'What should Pi review or propose?', ignoreFocusOut: true,
    validateInput: (value) => value.trim() && Buffer.byteLength(value) <= 16384 ? null : 'Enter a task up to 16 KiB.' });
  if (!prompt?.trim()) return;
  const query = await vscode.window.showInputBox({ prompt: `Search the ${team ? 'team' : 'project'} repository for source`, ignoreFocusOut: true,
    validateInput: (value) => value.trim() && Buffer.byteLength(value) <= 1024 ? null : 'Enter a search query up to 1 KiB.' });
  if (!query?.trim()) return;
  const selected = await vscode.window.showQuickPick(project.scopes.map((path) => ({ label: path, path })),
    { placeHolder: team ? 'Choose approved team repository directories' : 'Choose approved repository directories', canPickMany: true, ignoreFocusOut: true });
  if (!selected?.length) return;
  const scopes = selected.map(({ path }) => path);
  const narrower = await vscode.window.showInputBox({ prompt: 'Narrow to repository subdirectories (optional)',
    placeHolder: 'Keep the selected directories by leaving this blank', ignoreFocusOut: true,
    validateInput: (value) => narrowerRepositoryDirectories(scopes, value) ? null : 'Enter up to eight comma-separated paths within the selected directories.' });
  if (narrower === undefined) return;
  const projects = narrowerRepositoryDirectories(scopes, narrower);
  if (!projects) return;
  return { prompt: prompt.trim(), source: { source: 'repository', query: query.trim(), projects } };
}

async function runTeamRequest(connection) {
  const review = ++requestReview;
  const isCurrent = () => review === requestReview && connection.current();
  const canSubmit = async () => isCurrent() && await connection.isBound() && isCurrent();
  const [project] = connection.projects;
  const { presets } = await connection.api(pathFor(project, 'presets'));
  if (!isCurrent()) return;
  const item = await vscode.window.showQuickPick([
    { label: 'New repository request' }, ...presets.map((preset) => ({ label: preset.name, description: 'Saved preset', preset })),
  ], { placeHolder: `Choose a request for ${project.title}`, ignoreFocusOut: true });
  if (!item || !isCurrent()) return;
  const draft = item.preset ? { name: item.preset.name, prompt: item.preset.prompt,
    source: { source: 'repository', query: item.preset.query, profile: item.preset.profile } } : await repositoryRequestDraft(project, true);
  if (!draft || !isCurrent()) return;
  const session = await chooseSession();
  if (!session) return;
  await reviewRepositoryRequest(connection, project, { ...draft, session }, isCurrent, canSubmit);
}

async function reviewRepositoryRequest(connection, project, { name, prompt, session, source }, isCurrent, canSubmit) {
  if (!await canSubmit()) return;
  const team = connection.mode === 'team';
  const preview = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
    title: team ? 'Previewing scope in the team repository' : 'Previewing repository source locally' },
    () => connection.api(pathFor(project, 'preview'), source));
  if (!await canSubmit()) return;
  if (preview?.source !== 'repository' || typeof preview.manifest?.id !== 'string' || !/^[a-f0-9]{64}$/u.test(preview.manifest.id) ||
      !Array.isArray(preview.excerpts)) throw new Error('Could not verify the selected repository preview.');
  if (!preview.excerpts.length) return vscode.window.showInformationMessage(name && !team
    ? 'No source matched this preset. Edit its query or profile in the Coding workspace and try again.'
    : 'No source matched this request. Choose a different query or approved directory and try again.');

  const lookup = await sourceLookupChoice('Allow lookups in approved excerpts');
  if (!lookup || !await canSubmit()) return;
  const previewEditor = vscode.window.activeTextEditor;
  const previewRevision = editorRevision;
  const canDisplay = () => isCurrent() && editorRevision === previewRevision && vscode.window.activeTextEditor === previewEditor;
  await confirmRequestPreview(connection, project, team ? 'Team request preview' : name ? 'Project preset preview' : 'Repository request preview', [
    `Project: ${project.title}`, ...(team ? [`Team workspace: ${connection.url.origin}`] : []), `Repository search: ${source.query}`,
    ...(name ? [`Preset: ${name}`] : []), `Provider and model: ${project.provider} / ${project.model}`, `Session: ${session}`,
    `Source lookup: ${lookup.enabled ? 'Allowed within the approved excerpts' : 'Off'}`,
    '', 'Task', prompt,
    ...(preview.guidance ? ['', 'Project guidance', preview.guidance] : []),
    ...preview.excerpts.flatMap(({ path, startLine, endLine, content }) => ['', `${path}:${startLine}–${endLine}`, content]),
  ],
    `Review the task and excerpts in the editor. Sending includes active session history and uses ${project.provider} / ${project.model}${team ? ` through ${connection.url.origin}` : ''}.`,
    { ...source, session, prompt, previewId: preview.manifest.id, ...(lookup.enabled ? { approvedSourceLookup: true } : {}) },
    canDisplay, canSubmit);
}

async function resetOwnerContext(connection, project, session, isCurrent) {
  if (!isCurrent()) return;
  const draft = await vscode.window.showInputBox({ prompt: 'Optional handoff for the next request',
    placeHolder: 'One line, or press Enter to leave it blank', ignoreFocusOut: true,
    validateInput: (value) => /[\r\n\u2028\u2029]/u.test(value) ? 'Use a single line for the handoff.'
      : Buffer.byteLength(value) > 2048 ? 'Keep the handoff within 2,048 UTF-8 bytes.' : null });
  if (draft === undefined || !isCurrent()) return;
  const handoff = draft.trim() ? draft : undefined;
  const preview = await connection.api(pathFor(project, 'reset-context-preview'), { session, ...(handoff === undefined ? {} : { handoff }) });
  if (!isCurrent()) return;
  if (typeof preview?.version !== 'string' || !preview.version) throw new Error('Could not preview this session’s context.');
  const approved = preview.handoff;
  if (approved !== handoff) {
    throw new Error('Could not preview the handoff for this session. Update okbrain or leave the handoff blank.');
  }
  const options = { modal: true, ...(approved === undefined ? {} : { detail: approved }) };
  const confirmed = await vscode.window.showWarningMessage(
    `Start fresh context for session ${session}? Saved runs stay available. ` +
      'The next request you start will begin without earlier turns.' +
      (approved === undefined ? '' : ' It will include the handoff shown below.'),
    options, 'Start Fresh Context');
  if (confirmed !== 'Start Fresh Context' || !isCurrent()) return;
  const result = await connection.api(pathFor(project, 'reset-context'), { session, version: preview.version,
    ...(approved === undefined ? {} : { handoff: approved }) });
  if (!isCurrent()) return;
  if (!result?.reset) throw new Error('The session did not confirm the context reset. Refresh Run history before trying again.');
  await vscode.window.showInformationMessage(`Started fresh context for ${session}. Saved runs remain in Run history.`);
}

async function compactOwnerContext(connection, project, session, isCurrent) {
  if (!isCurrent()) return;
  const preview = await connection.api(pathFor(project, 'compact-context-preview'), { session });
  if (!isCurrent()) return;
  const version = preview?.version;
  if (typeof version !== 'string' || !version) throw new Error('Could not preview local compaction for this session.');

  const recovering = preview.recovering === true;
  const button = recovering ? 'Resume Compaction' : 'Compact Context';
  const confirmed = await vscode.window.showWarningMessage(
    `${recovering ? 'Resume local compaction' : 'Compact context locally'} for session ${session}? ` +
      'A recap condenses older turns in the active context. The recap runs entirely on this device, and the originals stay in Run history. ' +
      'Compaction skips sessions with too little older history.',
    { modal: true }, button);
  if (confirmed !== button || !isCurrent()) return;
  const result = await connection.api(pathFor(project, 'compact-context'), { session, version });
  if (!isCurrent()) return;
  if (result?.version !== version || typeof result.compacted !== 'boolean') {
    throw new Error('Could not verify the compaction result. Refresh Run history before trying again.');
  }
  if (!result.compacted) {
    await vscode.window.showInformationMessage(`Session ${session} has too little older history for compaction.`);
    return;
  }
  await vscode.window.showInformationMessage(
    `${recovering ? 'Recovered local compaction' : 'Compacted context locally'} for ${session}. Saved runs remain in Run history.`);
}

function contextBudgetLines(context) {
  const lines = [
    ['Estimated active context', context?.estimatedTokens, 0],
    ['Input token cap', context?.limitTokens, 1],
    ['Output reserve', context?.maxOutputTokens, 1],
    ['Model window', context?.modelWindowTokens, 1],
  ].flatMap(([label, value, minimum]) => Number.isSafeInteger(value) && value >= minimum
    ? [`${label}: ${value.toLocaleString()} tokens`] : []);
  if (context?.historyCompacted === true) lines.push('Earlier turns are compacted. Saved requests remain in Run history.');
  if (context?.compactionPending === true) lines.push('Local compaction is awaiting recovery.');
  return lines.length ? ['Session context budget', ...lines] : [];
}

function sourceLookupLines(lookup) {
  if (!Array.isArray(lookup?.served) || !Number.isSafeInteger(lookup.refused) || lookup.refused < 0 ||
      !Number.isSafeInteger(lookup.incomplete) || lookup.incomplete < 0) return [];
  const ranges = lookup.served.flatMap((range) => {
    const { path, startLine, endLine } = range ?? {};
    if (typeof path !== 'string' || !path || /[\\:\x00-\x1f\x7f]/u.test(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..') ||
        !Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(endLine) || endLine < startLine) return [];
    return [`${path}:${startLine}${endLine === startLine ? '' : `–${endLine}`}`];
  });
  return ['Approved source lookup', ...(ranges.length ? ranges : ['No approved ranges served.']),
    `${lookup.refused} refused · ${lookup.incomplete} incomplete`, ...(lookup.truncated === true ? ['Additional ranges omitted.'] : [])];
}

async function inspectRun(connection, project, selected) {
  const current = ++inspection;
  const team = connection.mode === 'team';
  const isCurrent = () => current === inspection && (!team || connection.current());
  const inspectedWorkspace = workspaceRevision;
  const folders = () => JSON.stringify(localWorkspaceFolders().map(({ uri }) => uri.fsPath));
  const startingFolders = folders();
  const identity = { session: selected.session, requestId: selected.id };
  const { run, pi, admissionMissing, liveAnswer, taskProgress, report, alternativeBranchEligible } =
    await connection.api(pathFor(project, 'inspect'), identity);
  if (!isCurrent()) return;
  const receipt = pi?.request?.receipt;
  const progress = taskProgressLines(taskProgress ?? pi?.request?.taskProgress, run.status === 'running');
  const budget = contextBudgetLines(pi?.context);
  const lookup = run.status === 'done' && run.id === identity.requestId && run.session === identity.session &&
    pi?.request?.requestId === identity.requestId && pi.request.approvedSourceLookup === true ? sourceLookupLines(pi.request.sourceLookup) : [];
  const contents = [
    project.title, ...(team ? [`Team workspace: ${connection.url.origin}`] : []),
    `Session: ${run.session}`, `Request: ${run.id}`, `Status: ${run.status}`,
    ...(run.review ? [`Review: ${run.review} by ${run.reviewer}`] : []),
    ...(run.error ? ['', run.error] : []),
    ...(admissionMissing ? ['', 'This request has no saved admission. Resume to recover its status.'] : []),
    ...(progress.length ? ['', ...progress] : []),
    ...(run.status === 'running' && liveAnswer?.text ? ['',
      liveAnswer.truncated ? 'Response in progress. Preview limit reached.' : 'Response in progress.', liveAnswer.text] : []),
    ...(receipt?.text ? ['', 'Pi response', receipt.text] : []),
    ...(receipt?.reason ? ['', receipt.reason] : []),
    ...(lookup.length ? ['', ...lookup] : []),
    ...(budget.length ? ['', ...budget] : []),
    ...(pi?.usage ? ['', 'Recorded session usage', JSON.stringify(pi.usage, null, 2)] : []),
  ].join('\n');
  if (team) await showReadOnlyText('Team coding run', contents, isCurrent);
  else await showText(contents);

  if (!isCurrent()) return;
  const inspectedEditor = editorRevision;
  const startingEditor = vscode.window.activeTextEditor;
  const sameInspection = () => isCurrent() && trustedEditor() && inspectedWorkspace === workspaceRevision &&
    startingFolders === folders() && inspectedEditor === editorRevision && startingEditor === vscode.window.activeTextEditor;
  const idle = run.admitted && run.status !== 'running' && run.status !== 'interrupted' && pi?.pendingRequestIds?.length === 0;
  const canChangeContext = () => !team && !run.branch && idle && sameInspection();
  const compactionPending = pi?.context?.compactionPending === true;
  const sameRun = run.session === identity.session && run.id === identity.requestId;
  const canCopyReport = !admissionMissing && run.status !== 'running' &&
    (run.admitted === true || pi?.request?.requestId === identity.requestId) &&
    sameRun &&
    report?.version === 1 && report.projectId === project.id && report.session === identity.session &&
    report.request?.requestId === identity.requestId && report.runStatus === run.status;
  const canOpenAlternative = !team && alternativeBranchEligible === true && sameRun &&
    run.status === 'done' && run.review === 'accepted';
  const original = run.branch;
  const canCompare = sameRun && !admissionMissing && run.admitted === true && run.status === 'done' &&
    typeof original?.session === 'string' && original.session !== identity.session && typeof original?.requestId === 'string';
  const canHandoffReview = !team && sameRun && run.status === 'done' && run.review === 'accepted';
  const choices = [{ label: 'Refresh', action: 'refresh' }, { label: 'Open in okbrain', action: 'open' }];
  if (run.status !== 'running' && (run.admitted || pi?.request || (run.status === 'interrupted' && !admissionMissing)))
    choices.push({ label: 'View saved request source', action: 'source-inspect' });
  if (canCopyReport && sameInspection()) choices.push({ label: 'Copy run report', action: 'copy-report' });
  if (canCompare && sameInspection()) choices.push({ label: 'Compare with original', action: 'branch-comparison-inspect' });
  if ((!team || !run.branch) && (run.status === 'running' || run.status === 'interrupted')) choices.push({ label: 'Cancel request', action: 'cancel' });
  if ((!team || !run.branch) && run.status === 'interrupted') choices.push({ label: 'Resume from saved context', action: 'resume' });
  if (run.status === 'done') choices.push(
    { label: 'Accept result', action: 'review', decision: 'accepted' },
    { label: 'Request changes', action: 'review', decision: 'changes_requested' });
  if (canChangeContext()) {
    if (!compactionPending) choices.push({ label: 'Start fresh context', action: 'reset-context' });
    choices.push({ label: 'Compact context locally', action: 'compact-context' });
  }
  if (canHandoffReview && sameInspection()) choices.push(
    { label: 'Review proposed patch in okbrain', action: 'patch' },
    { label: 'Prepare GitHub pull request in okbrain', action: 'github' });
  if (canOpenAlternative && sameInspection()) choices.push({ label: 'Preview alternative branch in okbrain', action: 'alternative-branch' });
  const action = await vscode.window.showQuickPick(choices, { placeHolder: 'Choose a run action', ignoreFocusOut: true });
  if (!action || !isCurrent() || (team && !await connection.isBound())) return;
  if (action.action === 'open') return openWeb(connection, project);
  if (action.action === 'patch' || action.action === 'github') {
    if (canHandoffReview && sameInspection()) return openWeb(connection, project, run, action.action);
    return;
  }
  if (action.action === 'branch-comparison-inspect') {
    if (canCompare && sameInspection()) return showBranchComparison(connection, project, identity, original, sameInspection);
    return;
  }
  if (action.action === 'alternative-branch') {
    if (canOpenAlternative && sameInspection()) return openWeb(connection, project, run, action.action);
    return;
  }
  if (action.action === 'refresh') return inspectRun(connection, project, run);
  if (action.action === 'source-inspect') return showSavedRequestSource(connection, project, identity, isCurrent);
  if (action.action === 'copy-report') {
    if (!canCopyReport || !sameInspection()) return;
    await vscode.env.clipboard.writeText(JSON.stringify(report, null, 2));
    if (sameInspection()) await vscode.window.showInformationMessage('Run report copied.');
    return;
  }
  if (action.action === 'reset-context') return resetOwnerContext(connection, project, run.session, () => !compactionPending && canChangeContext());
  if (action.action === 'compact-context') return compactOwnerContext(connection, project, run.session, canChangeContext);
  if (action.action === 'resume') {
    const proceed = await vscode.window.showWarningMessage('Resuming can make another provider call using the saved context.',
      { modal: true }, 'Resume');
    if (!proceed || (team && !isCurrent())) return;
  }
  const result = await connection.api(pathFor(project, action.action), action.decision ? { ...identity, decision: action.decision } : identity);
  await vscode.window.showInformationMessage(`Request ${result.id} · ${result.review || result.status}`);
}

async function listRuns(connection) {
  const item = await chooseProject(connection, connection.projects.map((project) => ({ label: project.title, project })));
  if (!item) return;
  const runs = await connection.api(pathFor(item.project, 'runs'));
  if (!runs.length) {
    await vscode.window.showInformationMessage('This project has no coding requests yet.');
    return;
  }
  const selected = await vscode.window.showQuickPick(runs.map((run) => ({ label: run.id,
    description: `${run.session} · ${run.status}`, detail: run.review || undefined, run })), { placeHolder: 'Choose a request to inspect' });
  if (selected) await inspectRun(connection, item.project, selected.run);
}

function activate(context) {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(savedSourceScheme, {
    provideTextDocumentContent: (uri) => openingSources.get(uri.toString()) ?? '',
  }));
  context.subscriptions.push(context.secrets.onDidChange(({ key }) => { if (key === teamSecret) ++teamRevision; }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { ++workspaceRevision; }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => { ++editorRevision; }));
  const register = (command, action) => context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
    try {
      if (!trustedEditor()) throw new Error('Open a trusted local folder to use okbrain Coding.');
      await action();
    } catch (error) { await vscode.window.showErrorMessage(error.message); }
  }));
  const owner = (command, action) => register(command, async () => {
    const settings = vscode.workspace.getConfiguration('okbrain').inspect('server');
    await action(await connect(settings?.globalValue));
  });
  const team = (command, action) => register(command, async () => {
    const connection = await openTeamConnection(context.secrets);
    if (connection) await action(connection);
  });
  owner('okbrain.open', openWeb);
  owner('okbrain.runFile', runActiveFile);
  owner('okbrain.runRepository', (connection) => runLocalRepositoryRequest(connection, false));
  owner('okbrain.runPreset', (connection) => runLocalRepositoryRequest(connection, true));
  owner('okbrain.runs', listRuns);
  register('okbrain.connectTeam', () => addTeamConnection(context.secrets));
  register('okbrain.disconnectTeam', () => removeTeamConnection(context.secrets));
  register('okbrain.openTeam', () => openTeamSignIn(context.secrets));
  team('okbrain.runTeam', runTeamRequest);
  team('okbrain.teamRuns', listRuns);
}

module.exports = { activate };
