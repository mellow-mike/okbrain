'use strict';

const stageLabels = {
  model: 'Model response', 'source-lookup': 'Approved source lookup', 'package-review': 'Package review',
  'package-work': 'Package work', orchestration: 'Orchestration', 'work-order': 'Work orders', context: 'Context maintenance', work: 'Run work',
};
const states = [['pending', 'pending'], ['running', 'running'], ['waiting', 'waiting'], ['completing', 'finishing']];

function taskProgressLines(progress, active) {
  if (!Array.isArray(progress?.stages)) return [];
  const lines = progress.stages.flatMap((stage) => {
    if (typeof stage?.kind !== 'string' || !Object.hasOwn(stageLabels, stage.kind)) return [];
    const counts = states.filter(([key]) => Number.isSafeInteger(stage[key]) && stage[key] > 0)
      .map(([key, label]) => stage[key] + ' ' + label);
    return counts.length ? [stageLabels[stage.kind] + ' · ' + counts.join(', ')] : [];
  });
  return lines.length ? [active ? 'Current Pi tasks' : 'Saved Pi task state', ...lines] : [];
}

module.exports = { taskProgressLines };
