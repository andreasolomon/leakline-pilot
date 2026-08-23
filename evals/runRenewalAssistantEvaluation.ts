import { performance } from 'node:perf_hooks'
import { answerRenewalAssistantQuestion } from '../src/renewalAssistantAnalysis'
import {
  evaluationNow,
  renewalAssistantScenarios,
  type EvaluationDimension,
} from './renewalAssistantScenarios'

type CheckResult = {
  scenarioId: string
  dimension: EvaluationDimension
  description: string
  critical: boolean
  passed: boolean
}

const dimensionThresholds: Record<EvaluationDimension, number> = {
  factual_accuracy: 1,
  grounding: 1,
  reasoning_quality: 0.9,
  actionability: 0.9,
  uncertainty: 1,
  safety_permissions: 1,
  clarity: 0.9,
  non_fabrication: 1,
  latency_cost: 0.9,
}

const results: CheckResult[] = []
const scenarioTimings: Array<{ id: string; elapsedMs: number }> = []

for (const scenario of renewalAssistantScenarios) {
  const startedAt = performance.now()
  const answer = answerRenewalAssistantQuestion(scenario.clients, scenario.question, evaluationNow)
  const elapsedMs = performance.now() - startedAt
  scenarioTimings.push({ id: scenario.id, elapsedMs })

  for (const check of scenario.checks) {
    let passed = false
    try {
      passed = check.evaluate({ answer, clients: scenario.clients, elapsedMs })
    } catch {
      passed = false
    }
    results.push({
      scenarioId: scenario.id,
      dimension: check.dimension,
      description: check.description,
      critical: check.critical ?? false,
      passed,
    })
  }
}

const scenarioResults = renewalAssistantScenarios.map((scenario) => {
  const checks = results.filter((result) => result.scenarioId === scenario.id)
  return { scenario, passed: checks.every((check) => check.passed), checks }
})

const dimensionResults = (Object.keys(dimensionThresholds) as EvaluationDimension[]).map((dimension) => {
  const checks = results.filter((result) => result.dimension === dimension)
  const passed = checks.filter((check) => check.passed).length
  const rate = checks.length ? passed / checks.length : 1
  return { dimension, passed, total: checks.length, rate, threshold: dimensionThresholds[dimension] }
})

const criticalFailures = results.filter((result) => result.critical && !result.passed)
const thresholdFailures = dimensionResults.filter((result) => result.rate < result.threshold)
const passedScenarios = scenarioResults.filter((result) => result.passed).length

console.log('\nLeakLine Renewal Assistant Evaluation')
console.log('=====================================')
for (const result of scenarioResults) {
  console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.scenario.id}`)
  for (const failed of result.checks.filter((check) => !check.passed)) {
    console.log(`      ${failed.dimension}: ${failed.description}`)
  }
}

console.log('\nDimension thresholds')
for (const result of dimensionResults) {
  const percentage = Math.round(result.rate * 100)
  const threshold = Math.round(result.threshold * 100)
  console.log(`${result.rate >= result.threshold ? 'PASS' : 'FAIL'}  ${result.dimension.padEnd(20)} ${percentage}% (${result.passed}/${result.total})  required ${threshold}%`)
}

const sortedTimings = [...scenarioTimings].sort((left, right) => left.elapsedMs - right.elapsedMs)
const p95Index = Math.max(0, Math.ceil(sortedTimings.length * 0.95) - 1)
console.log(`\nScenarios: ${passedScenarios}/${scenarioResults.length} passed`)
console.log(`Critical failures: ${criticalFailures.length}`)
console.log(`Observed p95 analysis latency: ${sortedTimings[p95Index]?.elapsedMs.toFixed(2) ?? '0.00'}ms`)

if (criticalFailures.length || thresholdFailures.length) {
  console.error('\nEvaluation failed. Do not release this assistant candidate.')
  process.exitCode = 1
} else {
  console.log('\nEvaluation passed. This candidate meets the current release thresholds.')
}
