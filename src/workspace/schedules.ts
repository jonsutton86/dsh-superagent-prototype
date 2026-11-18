/** Durable scheduling through the existing workspace, Engine transactions and effect queue. */
import { randomUUID } from 'node:crypto'
import { key } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import type { Workspace } from './service.ts'
import { WorkspaceError } from './model.ts'
import { firstOccurrence, occurrenceAt, validateCadence } from './cadence.ts'
import { reflectionPlan, type ReflectionSpec } from './reflection-model.ts'
import { CreateSchedule, SaveSchedule, ToggleSchedule, RetryOccurrence, type Schedule, type ScheduleDefinition,
  type ScheduleList, type ScheduleView, type ScheduleOccurrence } from './schedule-model.ts'

/** Persisted standing authorizations, bounded occurrence reservations, and resumable mission dispatch; no separate runner or credentials. */
export class Schedules {
  constructor(private readonly store: Store, private readonly workspace: Workspace, private readonly runnable: () => boolean,
    private readonly clock: () => number = Date.now,
    private readonly prepareReflection?: (occurrence: ScheduleOccurrence, missionId: string, spec: ReflectionSpec) => void) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_schedule (id TEXT PRIMARY KEY, value TEXT NOT NULL, checked INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER AS (value ->> '$.enabled'), due TEXT AS (value ->> '$.nextAt'));
      CREATE INDEX IF NOT EXISTS workspace_schedule_due ON workspace_schedule(enabled,due);
      CREATE TABLE IF NOT EXISTS workspace_schedule_version (schedule TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(schedule,revision));
      CREATE TABLE IF NOT EXISTS workspace_occurrence (id TEXT PRIMARY KEY, schedule TEXT NOT NULL, value TEXT NOT NULL,
        checked INTEGER NOT NULL DEFAULT 0, state TEXT AS (value ->> '$.state'));
      CREATE INDEX IF NOT EXISTS workspace_occurrence_schedule ON workspace_occurrence(schedule);
      CREATE INDEX IF NOT EXISTS workspace_occurrence_state ON workspace_occurrence(state,checked);
      CREATE TABLE IF NOT EXISTS workspace_schedule_command (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, schedule TEXT NOT NULL);`)
  }
  private require(id: string): Schedule {
    const row = this.store.db.prepare('SELECT value FROM workspace_schedule WHERE id=?').get(id)
    if (!row) throw new WorkspaceError(404, 'Schedule not found')
    return JSON.parse(String(row.value)) as Schedule
  }
  private save(schedule: Schedule): void {
    this.store.db.prepare('INSERT INTO workspace_schedule(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(schedule.id, JSON.stringify(schedule))
  }
  private saveOccurrence(occurrence: ScheduleOccurrence): void {
    this.store.db.prepare('INSERT INTO workspace_occurrence(id,schedule,value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(occurrence.id, occurrence.scheduleId, JSON.stringify(occurrence))
  }
  private open(id: string): number {
    const rows = this.store.db.prepare("SELECT value FROM workspace_occurrence WHERE schedule=? AND state IN ('active','blocked')").all(id)
    return rows.filter(row => {
      const occurrence = JSON.parse(String(row.value)) as ScheduleOccurrence
      if (!occurrence.missionId) return true
      const mission = this.workspace.get(occurrence.missionId, false)
      return mission.status === 'active' && mission.completed !== mission.actions.length
    }).length
  }
  get(id: string, offset = 0, limit = 30): ScheduleView {
    const schedule = this.require(id)
    const rows = this.store.db.prepare('SELECT value FROM workspace_occurrence WHERE schedule=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(id, limit + 1, offset)
    return { ...schedule, open: this.open(id), occurrences: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as ScheduleOccurrence),
      nextOffset: rows.length > limit ? offset + limit : null }
  }
  list(offset = 0, limit = 30): ScheduleList {
    const rows = this.store.db.prepare('SELECT value FROM workspace_schedule ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit + 1, offset)
    return { items: rows.slice(0, limit).map(row => {
      const { id, revision, enabled, runs, nextAt, definition: { title, maxRuns, maxOpen } } = JSON.parse(String(row.value)) as Schedule
      return { id, revision, enabled, runs, nextAt, title, maxRuns, maxOpen, open: this.open(id) }
    }), nextOffset: rows.length > limit ? offset + limit : null }
  }
  version(id: string, revision: number): Schedule {
    const row = this.store.db.prepare('SELECT value FROM workspace_schedule_version WHERE schedule=? AND revision=?').get(id, revision)
    if (!row) throw new WorkspaceError(404, 'Schedule version not found')
    return JSON.parse(String(row.value)) as Schedule
  }
  private snapshot(schedule: Schedule): void {
    this.store.db.prepare('INSERT INTO workspace_schedule_version VALUES (?,?,?)').run(schedule.id, schedule.revision, JSON.stringify(schedule))
  }
  private command(requestId: string, input: unknown, change: () => string): ScheduleView {
    return this.store.atomic(() => {
      const fingerprint = key(JSON.stringify(input)), old = this.store.db.prepare('SELECT * FROM workspace_schedule_command WHERE id=?').get(requestId)
      if (old) {
        if (old.fingerprint !== fingerprint) throw new WorkspaceError(409, 'This request ID was already used for another operation')
        return this.get(String(old.schedule))
      }
      const id = change()
      this.store.db.prepare('INSERT INTO workspace_schedule_command VALUES (?,?,?)').run(requestId, fingerprint, id)
      return this.get(id)
    })
  }
  private validate(definition: ScheduleDefinition): void {
    if (definition.reflection) {
      if (!this.prepareReflection) throw new WorkspaceError(409, 'Reflection is unavailable')
      definition.plan = reflectionPlan(definition.reflection)
    }
    try { validateCadence(definition.cadence); firstOccurrence(definition.cadence) }
    catch { throw new WorkspaceError(400, 'Choose a valid calendar and named time zone') }
  }
  create(input: unknown): ScheduleView {
    const request = CreateSchedule.parse(input)
    return this.command(request.requestId, { operation: 'create', ...request }, () => {
      this.validate(request.definition)
      const at = new Date(this.clock()).toISOString(), schedule: Schedule = { id: randomUUID(), revision: 1, definition: request.definition,
        enabled: request.enabled, runs: 0, nextAt: firstOccurrence(request.definition.cadence), createdAt: at, updatedAt: at }
      this.save(schedule); this.snapshot(schedule); return schedule.id
    })
  }
  update(id: string, input: unknown): ScheduleView {
    const request = SaveSchedule.parse(input)
    return this.command(request.requestId, { operation: 'update', id, ...request }, () => {
      const schedule = this.editable(id, request.revision)
      this.validate(request.definition)
      schedule.definition = request.definition; schedule.enabled = request.enabled
      // Editing a definition authorizes future work only. Pause/resume uses toggle and retains the missed-run cursor.
      schedule.nextAt = occurrenceAt(request.definition.cadence, Math.max(this.clock(), Date.parse(schedule.nextAt ?? new Date(this.clock()).toISOString())), 1)
      this.changed(schedule); return id
    })
  }
  toggle(id: string, input: unknown): ScheduleView {
    const request = ToggleSchedule.parse(input)
    return this.command(request.requestId, { operation: 'toggle', id, ...request }, () => {
      const schedule = this.editable(id, request.revision); schedule.enabled = request.enabled; this.changed(schedule); return id
    })
  }
  retry(id: string, occurrenceId: string, input: unknown): ScheduleView {
    const request = RetryOccurrence.parse(input)
    return this.command(request.requestId, { operation: 'retry', id, occurrenceId, ...request }, () => {
      this.require(id)
      const row = this.store.db.prepare('SELECT value FROM workspace_occurrence WHERE id=? AND schedule=?').get(occurrenceId, id)
      if (!row) throw new WorkspaceError(404, 'Occurrence not found')
      const occurrence = JSON.parse(String(row.value)) as ScheduleOccurrence
      if (occurrence.state !== 'blocked') throw new WorkspaceError(409, 'This occurrence is not blocked')
      occurrence.state = 'active'; delete occurrence.error; this.saveOccurrence(occurrence); return id
    })
  }
  private editable(id: string, revision: number): Schedule {
    const schedule = this.require(id)
    if (schedule.revision !== revision) throw new WorkspaceError(409, 'Schedule changed; reload before editing')
    return schedule
  }
  private changed(schedule: Schedule): void {
    schedule.revision++; schedule.updatedAt = new Date(this.clock()).toISOString(); this.save(schedule); this.snapshot(schedule)
  }
  /** Reserve at most eight occurrences and advance at most eight missions per pass; all state/effects commit together. */
  tick(): void {
    if (!this.runnable()) return
    const at = this.clock(), iso = new Date(at).toISOString()
    const due = this.store.db.prepare(`SELECT id FROM workspace_schedule WHERE enabled=1 AND due<=?
      AND value ->> '$.runs' < value ->> '$.definition.maxRuns' ORDER BY checked,due,id LIMIT 8`).all(iso)
    for (const row of due) {
      if (!this.runnable()) return
      this.store.atomic(() => {
        const schedule = this.require(String(row.id))
        this.store.db.prepare('UPDATE workspace_schedule SET checked=? WHERE id=?').run(at, schedule.id)
        this.reserve(schedule, at)
      })
    }
    for (const row of this.store.db.prepare("SELECT id,value FROM workspace_occurrence WHERE state='active' ORDER BY checked,rowid LIMIT 8").all()) {
      if (!this.runnable()) return
      const occurrence = JSON.parse(String(row.value)) as ScheduleOccurrence
      this.store.db.prepare('UPDATE workspace_occurrence SET checked=? WHERE id=?').run(at, occurrence.id)
      if (!this.require(occurrence.scheduleId).enabled) continue
      try { this.store.atomic(() => this.advance(occurrence)) }
      catch (failure) {
        // Reload after rollback: an uncommitted mission ID must never become an occurrence's target.
        const saved = JSON.parse(String(this.store.db.prepare('SELECT value FROM workspace_occurrence WHERE id=?').get(occurrence.id)!.value)) as ScheduleOccurrence
        saved.state = 'blocked'; saved.error = failure instanceof WorkspaceError ? failure.message : 'Scheduled dispatch failed; inspect runtime health and retry.'
        this.saveOccurrence(saved)
      }
    }
  }
  private reserve(schedule: Schedule, at: number): void {
    if (!schedule.enabled || !schedule.nextAt || Date.parse(schedule.nextAt) > at || schedule.runs >= schedule.definition.maxRuns) return
    const definition = schedule.definition, latest = occurrenceAt(definition.cadence, at, -1)!
    let due = schedule.nextAt
    if (definition.missed !== 'all') {
      const skipLatest = definition.missed === 'skip' && at - Date.parse(latest) > definition.graceSeconds * 1000
      const through = skipLatest ? latest : occurrenceAt(definition.cadence, Date.parse(latest) - 1, -1)
      if (through && through >= due) {
        this.saveOccurrence({ id: key('schedule-skip', schedule.id, String(schedule.revision), due), scheduleId: schedule.id,
          revision: schedule.revision, due, through, createdAt: new Date(at).toISOString(), state: 'skipped' })
        schedule.nextAt = occurrenceAt(definition.cadence, Date.parse(through) + 1, 1); this.save(schedule)
      }
      if (skipLatest) return
      due = latest
    }
    if (this.open(schedule.id) >= definition.maxOpen) return
    const occurrence: ScheduleOccurrence = { id: key('schedule-run', schedule.id, String(schedule.revision), due), scheduleId: schedule.id,
      revision: schedule.revision, due, createdAt: new Date(at).toISOString(), state: 'active' }
    this.saveOccurrence(occurrence)
    schedule.runs++; schedule.nextAt = occurrenceAt(definition.cadence, Date.parse(due) + 1, 1); this.save(schedule)
  }
  private advance(occurrence: ScheduleOccurrence): void {
    if (!occurrence.missionId) {
      const { definition } = this.version(occurrence.scheduleId, occurrence.revision)
      occurrence.missionId = this.workspace.createScheduled(key('scheduled-mission', occurrence.id), definition.plan,
        { id: occurrence.scheduleId, revision: occurrence.revision, occurrence: occurrence.id, due: occurrence.due }).id
      if (definition.reflection) {
        if (!this.prepareReflection) throw new WorkspaceError(409, 'Reflection is unavailable')
        this.prepareReflection(occurrence, occurrence.missionId, definition.reflection)
      }
      this.saveOccurrence(occurrence)
    }
    const mission = this.workspace.get(occurrence.missionId, false)
    if (mission.status === 'archived') occurrence.state = 'archived'
    else if (mission.completed === mission.actions.length) occurrence.state = 'complete'
    else {
      if (mission.planVersion !== 1) throw new WorkspaceError(409, 'The occurrence plan changed; finish or archive it manually.')
      for (const action of mission.actions.filter(action => action.owner === 'agent' && action.status === 'todo' && !action.runs.length).slice(0, 4))
        this.workspace.runScheduled(mission.id, action.id, key('scheduled-action', occurrence.id, action.id))
    }
    this.saveOccurrence(occurrence)
  }
}
