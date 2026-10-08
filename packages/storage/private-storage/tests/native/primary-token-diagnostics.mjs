/** Preserve bounded SDK startup observations; these never satisfy native-addon admission. */
export function collectPrimaryStartupDiagnostics(invoke) {
  const observations = []
  for (const args of [['token-group-facts'], ['primary-probe', 'ordinary'], ['primary-probe', 'restricted'], ['primary-probe', 'restricted-caller-groups'], ['primary-node-probe', 'restricted']]) {
    try { observations.push({ args, result: invoke(...args) }) }
    catch (error) { observations.push({ args, error: error.message }) }
  }
  return { evidence: 'sdk-startup-diagnostic-only', nativeAddonAcceptance: false, observations }
}
