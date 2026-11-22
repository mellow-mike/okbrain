'use strict';

const vscode = require('vscode');
const { randomUUID } = require('node:crypto');
const { connect, projectFile, matchesProjectWorkspace } = require('./connection.cjs');
const { taskProgressLines } = require('./run-progress.cjs');

const savedSourceScheme = 'okbrain-saved-source';
const openingSources = new Map();
let inspection = 0;
let presetReview = 0;

function pathFor(project, action) {
  return `/projects/${encodeURIComponent(project.id)}/${action}`;
}

function openWeb(connection, project, run, section) {
  const target = new URL(connection.url);
  const folder = vscode.workspace.workspaceFolders?.find((item) => item.uri.scheme === 'file');
  target.hash = project ? `coding/${encodeURIComponent(project.id)}` : folder
    ? `coding/${encodeURIComponent(`workspace=${folder.uri.fsPath}`)}` : 'coding';
  if (project && run) target.hash += `/${section}/${encodeURIComponent(run.session)}/${encodeURIComponent(run.id)}`;
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
    if (isCurrent()) await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
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

function chooseSession() {
  return vscode.window.showInputBox({ prompt: 'Coding session name', value: 'ide-review', ignoreFocusOut: true,
    validateInput: (input) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(input) ? null : 'Use lowercase letters, digits, hyphens, or underscores.' });
}

async function submitApprovedRequest(connection, project, request, canSubmit = () => true) {
  if (!await canSubmit()) return;
  let run;
  try { run = await connection.api(pathFor(project, 'run'), request); }
  catch (error) {
    const retry = await vscode.window.showErrorMessage(`${error.message} Request ID: ${request.requestId}.`, 'Try Same Request');
    if (!retry || !await canSubmit()) return;
    run = await connection.api(pathFor(project, 'run'), request);
  }
  const inspect = await vscode.window.showInformationMessage(`Coding request ${run.id} is ${run.status}.`, 'Inspect Request');
  if (inspect) await inspectRun(connection, project, run);
}

async function runActiveFile(connection) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') throw new Error('Open a local file first.');
  if (editor.document.isDirty) throw new Error('Save the active file before previewing the bytes on disk.');
  const choices = [];
  for (const project of connection.projects) {
    if (!project.workspace) continue;
    const relative = await projectFile(project.workspace, editor.document.uri.fsPath).catch(() => null);
    if (relative) choices.push({ label: project.title, description: relative, project, relative });
  }
  const choice = await chooseProject(connection, choices);
  if (!choice) return;

  const prompt = await vscode.window.showInputBox({ prompt: 'What should Pi review or propose?', ignoreFocusOut: true,
    validateInput: (input) => input.trim() ? null : 'Enter a request.' });
  if (!prompt) return;
  const session = await chooseSession();
  if (!session) return;

  const source = { source: 'files', files: [choice.relative] };
  const preview = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Previewing source locally' },
    () => connection.api(pathFor(choice.project, 'preview'), source));
  await showText([
    `Project: ${choice.project.title}`, `Provider and model: ${choice.project.provider} / ${choice.project.model}`,
    `Session: ${session}`, '', 'Request', prompt, '',
    ...preview.files.flatMap((file) => [`File: ${file.path}`, file.content, '']),
  ].join('\n'));
  const send = await vscode.window.showInformationMessage(
    'Review the source preview. Sending includes active session history. Source lookup reads only this request’s approved file.',
    'Send Request', 'Send with Source Lookup');
  if (!send) return;

  await submitApprovedRequest(connection, choice.project, {
    ...source, session, requestId: `ide-${randomUUID()}`, prompt, previewId: preview.id, approved: true,
    ...(send === 'Send with Source Lookup' ? { approvedSourceLookup: true } : {}),
  });
}

function localWorkspaceFolders() {
  return vscode.workspace.workspaceFolders?.filter(({ uri }) => uri.scheme === 'file') ?? [];
}

async function runPreset(connection) {
  const review = ++presetReview;
  const isCurrent = () => review === presetReview;
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
  if (!choices.length) throw new Error('Open the registered project folder to preview a saved request preset.');
  const choice = await chooseProject(connection, choices);
  if (!choice || !isCurrent()) return;
  const { project, workspace } = choice;
  const confirmWorkspace = async () => {
    if (!isCurrent()) return false;
    const file = vscode.window.activeTextEditor?.document.uri;
    if (!vscode.workspace.isTrusted || vscode.env.remoteName || !localWorkspaceFolders().some(({ uri }) => uri.fsPath === workspace) ||
        (file?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(file)?.uri.fsPath !== workspace) ||
        !await matchesProjectWorkspace(project.workspace, workspace).catch(() => false)) {
      throw new Error('The open workspace changed. Open the registered project and preview the preset again.');
    }
    return isCurrent();
  };

  if (!await confirmWorkspace()) return;
  const { presets } = await connection.api(pathFor(project, 'presets'));
  if (!isCurrent()) return;
  if (!presets.length) return vscode.window.showInformationMessage('This project has no saved request presets.');
  const item = await vscode.window.showQuickPick(presets.map((preset) => ({ label: preset.name, preset })),
    { placeHolder: 'Choose a saved request preset', ignoreFocusOut: true });
  if (!item || !isCurrent()) return;
  const { name, prompt, query, profile } = item.preset;
  const session = await chooseSession();
  if (!session || !await confirmWorkspace()) return;

  const source = { source: 'repository', query, profile };
  const preview = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Previewing repository source locally' },
    () => connection.api(pathFor(project, 'preview'), source));
  if (!isCurrent()) return;
  if (!preview.excerpts.length) return vscode.window.showInformationMessage('No source matched this preset. Edit its query or profile in the Coding workspace and try again.');

  const lookup = await vscode.window.showQuickPick([
    { label: 'Keep source lookup off', enabled: false },
    { label: 'Allow lookups in approved excerpts', enabled: true },
  ], { placeHolder: 'Choose source lookup for this request', ignoreFocusOut: true });
  if (!lookup || !await confirmWorkspace()) return;
  await showReadOnlyText('Project preset preview', [
    `Project: ${project.title}`, `Preset: ${name}`, `Provider and model: ${project.provider} / ${project.model}`, `Session: ${session}`,
    `Source lookup: ${lookup.enabled ? 'Allowed within the approved excerpts' : 'Off'}`,
    '', 'Task', prompt,
    ...(preview.guidance ? ['', 'Project guidance', preview.guidance] : []),
    ...preview.excerpts.flatMap(({ path, startLine, endLine, content }) => ['', `${path}:${startLine}–${endLine}`, content]),
  ].join('\n'), isCurrent);
  if (!isCurrent()) return;
  const send = await vscode.window.showInformationMessage(
    `Review the task and excerpts in the editor. Sending includes active session history and uses ${project.provider} / ${project.model}.`,
    'Send Request');
  if (send !== 'Send Request') return;

  await submitApprovedRequest(connection, project, {
    ...source, session, requestId: `ide-${randomUUID()}`, prompt, previewId: preview.manifest.id, approved: true,
    ...(lookup.enabled ? { approvedSourceLookup: true } : {}),
  }, confirmWorkspace);
}

async function inspectRun(connection, project, selected) {
  const current = ++inspection;
  const isCurrent = () => current === inspection;
  const identity = { session: selected.session, requestId: selected.id };
  const { run, pi, admissionMissing, liveAnswer, taskProgress } = await connection.api(pathFor(project, 'inspect'), identity);
  if (!isCurrent()) return;
  const receipt = pi?.request?.receipt;
  const progress = taskProgressLines(taskProgress ?? pi?.request?.taskProgress, run.status === 'running');
  await showText([
    project.title, `Session: ${run.session}`, `Request: ${run.id}`, `Status: ${run.status}`,
    ...(run.review ? [`Review: ${run.review} by ${run.reviewer}`] : []),
    ...(run.error ? ['', run.error] : []),
    ...(admissionMissing ? ['', 'This request has no saved admission. Resume to recover its status.'] : []),
    ...(progress.length ? ['', ...progress] : []),
    ...(run.status === 'running' && liveAnswer?.text ? ['',
      liveAnswer.truncated ? 'Response in progress. Preview limit reached.' : 'Response in progress.', liveAnswer.text] : []),
    ...(receipt?.text ? ['', 'Pi response', receipt.text] : []),
    ...(receipt?.reason ? ['', receipt.reason] : []),
    ...(pi?.usage ? ['', 'Recorded session usage', JSON.stringify(pi.usage, null, 2)] : []),
  ].join('\n'));

  if (!isCurrent()) return;
  const choices = [{ label: 'Refresh', action: 'refresh' }, { label: 'Open in okbrain', action: 'open' }];
  if (run.status !== 'running' && (run.admitted || pi?.request || (run.status === 'interrupted' && !admissionMissing)))
    choices.push({ label: 'View saved request source', action: 'source-inspect' });
  if (run.status === 'running' || run.status === 'interrupted') choices.push({ label: 'Cancel request', action: 'cancel' });
  if (run.status === 'interrupted') choices.push({ label: 'Resume from saved context', action: 'resume' });
  if (run.status === 'done') choices.push(
    { label: 'Accept result', action: 'review', decision: 'accepted' },
    { label: 'Request changes', action: 'review', decision: 'changes_requested' });
  if (run.status === 'done' && run.review === 'accepted')
    choices.push({ label: 'Review proposed patch in okbrain', action: 'patch' });
  if (run.review === 'accepted') choices.push({ label: 'Prepare GitHub pull request in okbrain', action: 'github' });
  const action = await vscode.window.showQuickPick(choices, { placeHolder: 'Choose a run action', ignoreFocusOut: true });
  if (!action || !isCurrent()) return;
  if (action.action === 'open') return openWeb(connection, project);
  if (action.action === 'patch' || action.action === 'github') return openWeb(connection, project, run, action.action);
  if (action.action === 'refresh') return inspectRun(connection, project, run);
  if (action.action === 'source-inspect') return showSavedRequestSource(connection, project, identity, isCurrent);
  if (action.action === 'resume') {
    const proceed = await vscode.window.showWarningMessage('Resuming can make another provider call using the saved context.',
      { modal: true }, 'Resume');
    if (!proceed) return;
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
  const register = (command, action) => context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
    try {
      if (!vscode.workspace.isTrusted || vscode.env.remoteName) throw new Error('Open a trusted local folder to use okbrain Coding.');
      const settings = vscode.workspace.getConfiguration('okbrain').inspect('server');
      const connection = await connect(settings?.globalValue);
      await action(connection);
    } catch (error) { await vscode.window.showErrorMessage(error.message); }
  }));
  register('okbrain.open', openWeb);
  register('okbrain.runFile', runActiveFile);
  register('okbrain.runPreset', runPreset);
  register('okbrain.runs', listRuns);
}

module.exports = { activate };
