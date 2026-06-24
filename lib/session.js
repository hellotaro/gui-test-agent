// セッション中に実行されたステップ履歴の状態管理

let sessionExecutedSteps = [];

export function resetSessionSteps() {
  sessionExecutedSteps = [];
}

export function pushSessionStep(step) {
  sessionExecutedSteps.push({
    timestamp: new Date().toISOString(),
    ...step
  });
}

export function getSessionSteps() {
  return sessionExecutedSteps;
}

export function deleteSessionStep(index) {
  if (index >= 0 && index < sessionExecutedSteps.length) {
    sessionExecutedSteps = sessionExecutedSteps
      .slice(0, index)
      .concat(sessionExecutedSteps.slice(index + 1));
  }
}
