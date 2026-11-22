'use strict';

const vscode = require('vscode');
const { randomUUID } = require('node:crypto');
const { connect, projectFile } = require('./connection.cjs');
const { taskProgressLines } = require('./run-progress.cjs');

function pathFor(project, action) {
  return `/projects/${encodeURIComponent(project.id)}/${action}`;
}

function openWeb(connection, project, githubRun) {
  const target = new URL(connection.url);
  const folder = vscode.workspace.workspaceFolders?.find((item) => item.uri.scheme === 'file');
  target.hash = project ? `coding/${encodeURIComponent(project.id)}` : folder
    ? `coding/${encodeURIComponent(`workspace=${folder.uri.fsPath}`)}` : 'coding';
  if (project && githubRun) target.hash += `/github/${encodeURIComponent(githubRun.session)}/${encodeURIComponent(githubRun.id)}`;
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
  const session = await vscode.window.showInputBox({ prompt: 'Coding session name', value: 'ide-review', ignoreFocusOut: true,
    validateInput: (input) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(input) ? null : 'Use lowercase letters, digits, hyphens, or underscores.' });
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

  const requestId = `ide-${randomUUID()}`;
  const request = { ...source, session, requestId, prompt, previewId: preview.id, approved: true,
    ...(send === 'Send with Source Lookup' ? { approvedSourceLookup: true } : {}) };
  let run;
  try { run = await connection.api(pathFor(choice.project, 'run'), request); }
  catch (error) {
    const retry = await vscode.window.showErrorMessage(`${error.message} Request ID: ${requestId}.`, 'Try Same Request');
    if (!retry) return;
    run = await connection.api(pathFor(choice.project, 'run'), request);
  }
  const inspect = await vscode.window.showInformationMessage(`Coding request ${run.id} is ${run.status}.`, 'Inspect Request');
  if (inspect) await inspectRun(connection, choice.project, run);
}

async function inspectRun(connection, project, selected) {
  const identity = { session: selected.session, requestId: selected.id };
  const { run, pi, admissionMissing, liveAnswer, taskProgress } = await connection.api(pathFor(project, 'inspect'), identity);
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

  const choices = [{ label: 'Refresh', action: 'refresh' }, { label: 'Open in okbrain', action: 'open' }];
  if (run.status === 'running' || run.status === 'interrupted') choices.push({ label: 'Cancel request', action: 'cancel' });
  if (run.status === 'interrupted') choices.push({ label: 'Resume from saved context', action: 'resume' });
  if (run.status === 'done') choices.push(
    { label: 'Accept result', action: 'review', decision: 'accepted' },
    { label: 'Request changes', action: 'review', decision: 'changes_requested' });
  if (run.review === 'accepted') choices.push({ label: 'Prepare GitHub pull request in okbrain', action: 'github' });
  const action = await vscode.window.showQuickPick(choices, { placeHolder: 'Choose a run action', ignoreFocusOut: true });
  if (!action) return;
  if (action.action === 'open') return openWeb(connection, project);
  if (action.action === 'github') return openWeb(connection, project, run);
  if (action.action === 'refresh') return inspectRun(connection, project, run);
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
  register('okbrain.runs', listRuns);
}

module.exports = { activate };
