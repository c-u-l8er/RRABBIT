import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, register, reset, log, replay, precheck, opCounts } from '../m2/ops.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const step = { op: 'read', district: 'proof', side: 1, dash: 0 }

test('pending host work has no success record; record the resolved arrival', async () => {
  reset()
  const host = deferred()
  register('back', { perform: async op => { await host.promise; op.to = 'proof'; return 'arrived' } })
  const result = apply({ op: 'back' }, { by: 'program' })
  assert.equal(log().length, 0)
  assert.equal(opCounts().applied, 0)
  host.resolve()
  assert.equal((await result).result, 'arrived')
  assert.equal(log()[0].to, 'proof')
  assert.equal(log()[0].by, 'program')
  assert.equal(opCounts().applied, 1)
})

test('resolved host refusal and rejected transport never enter the successful log', async () => {
  reset()
  register('read', { perform: async () => ({ ok: false, why: 'PRINCIPAL_REVOKED', detail: 'pane-2' }) })
  assert.equal((await apply(step)).why, 'PRINCIPAL_REVOKED')
  register('read', { perform: async () => { throw new Error('transport down') } })
  const failed = await apply(step)
  assert.equal(failed.why, 'OP_THREW')
  assert.match(failed.detail, /transport down/)
  assert.equal(log().length, 0)
  assert.equal(opCounts().refused, 2)
})

test('synchronous callers keep immediate values', () => {
  reset()
  register('read', { perform: () => 'ready' })
  assert.equal(apply(step).result, 'ready')
  assert.equal(replay([step]).ok, true)
  assert.equal(precheck([step]).ok, true)
})

test('mixed replay waits for each host effect before starting its successor', async () => {
  reset()
  const gate = deferred(), seen = [], callbacks = []
  register('read', { perform: async () => { seen.push('start'); await gate.promise; seen.push('ready') } })
  register('unread', { perform: () => seen.push('closed') })
  const result = replay([step, { op: 'unread' }], { onStep: i => callbacks.push(i) })
  assert.deepEqual(seen, ['start'])
  assert.deepEqual(callbacks, [])
  gate.resolve()
  assert.equal((await result).ran, 2)
  assert.deepEqual(seen, ['start', 'ready', 'closed'])
  assert.deepEqual(callbacks, [0, 1])
  assert.equal(log().length, 0)
})

test('replay stops at a delayed refusal, or continues only when requested', async () => {
  for (const stopOnRefusal of [true, false]) {
    reset()
    let tail = 0
    register('read', { perform: async () => ({ ok: false, why: 'HOST_REFUSED' }) })
    register('unread', { perform: () => { tail++ } })
    const result = await replay([step, { op: 'unread' }], { stopOnRefusal })
    assert.equal(result.ok, false)
    assert.equal(result.ran, stopOnRefusal ? 1 : 2)
    assert.equal(tail, stopOnRefusal ? 0 : 1)
  }
})

test('async preconditions finish before effects and precheck remains effect-free', async () => {
  reset()
  const gate = deferred()
  let effects = 0
  register('read', { pre: () => gate.promise, perform: () => { effects++ } })
  const result = apply(step)
  assert.equal(effects, 0)
  gate.resolve('HOST_NOT_READY')
  assert.equal((await result).why, 'HOST_NOT_READY')
  assert.equal((await precheck([step])).why, 'HOST_NOT_READY')
  assert.equal(effects, 0)
  register('read', { pre: async () => true, perform: () => { effects++ } })
  assert.equal((await precheck([step])).ok, true)
  assert.equal(effects, 0)
  assert.equal((await apply(step)).ok, true)
  assert.equal(effects, 1)
})

test('rejected async preconditions become named refusals', async () => {
  reset()
  register('read', { pre: async () => { throw new Error('offline') }, perform: () => assert.fail('must not run') })
  assert.equal((await apply(step)).why, 'OP_PRECONDITION_THREW')
  assert.equal((await precheck([step])).why, 'OP_PRECONDITION_THREW')
})

test('reset fences late completion and prevents a replay continuing into another world', async () => {
  for (const success of [true, false]) {
    reset()
    const gate = deferred()
    register('read', { perform: () => gate.promise })
    let tail = 0
    register('unread', { perform: () => { tail++ } })
    const result = replay([step, { op: 'unread' }], { stopOnRefusal: false })
    reset()
    success ? gate.resolve('ready') : gate.reject(new Error('late'))
    assert.equal((await result).steps[0].why, 'OP_RESET')
    assert.equal(tail, 0)
    assert.equal(log().length, 0)
    assert.equal(opCounts().applied, 0)
    assert.equal(opCounts().refused, 0)
  }
})

test('a reset while preconditions wait prevents the host effect', async () => {
  reset()
  const gate = deferred()
  register('read', { pre: () => gate.promise, perform: () => assert.fail('old effect') })
  const result = apply(step)
  reset()
  gate.resolve(true)
  assert.equal((await result).why, 'OP_RESET')
})

test('actor annotations do not change delayed host behavior', async () => {
  for (const by of ['pointer', 'program', 'replay', 'cockpit']) {
    reset()
    register('read', { perform: async () => ({ ok: false, why: 'HOST_REFUSED' }) })
    assert.equal((await apply(step, { by })).why, 'HOST_REFUSED')
    assert.equal(log().length, 0)
  }
})
