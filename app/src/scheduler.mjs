import { nextOccurrence } from './store.mjs';

export class Scheduler {
  constructor({ store, engine, bus }) {
    this.store = store;
    this.engine = engine;
    this.bus = bus;
    this.timer = null;
    this.initialTimer = null;
    this.running = false;
  }

  start() {
    this.stop();
    this.initialTimer = setTimeout(() => this.tick(), 3000);
    this.timer = setInterval(() => this.tick(), 15_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.timer = null;
    this.initialTimer = null;
  }

  async tick() {
    if (this.running || this.engine.isBusy()) return;

    const now = Date.now();
    const due = this.store.state.tasks
      .filter((task) => task.enabled && task.nextRunAt && new Date(task.nextRunAt).getTime() <= now)
      .sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt));

    if (!due.length) return;
    const task = due[0];
    const lag = now - new Date(task.nextRunAt).getTime();
    const settings = this.store.state.settings;
    const catchUpHours = Math.max(1, Number(settings.catchUpHours) || 12);

    if (settings.catchUp === false || (task.schedule?.type !== 'interval' && lag > catchUpHours * 3_600_000)) {
      task.nextRunAt = nextOccurrence(task.schedule, new Date());
      task.lastMissedAt = new Date().toISOString();
      this.store.save();
      this.bus.emitState();
      return;
    }

    task.nextRunAt = nextOccurrence(task.schedule, new Date());
    this.store.save();
    this.bus.emitState();

    this.running = true;
    try {
      await this.engine.runTask(task, 'schedule');
    } catch (error) {
      task.lastError = String(error.message || error).slice(0, 300);
      this.store.save();
      this.bus.emitState();
      console.error('[scheduler]', task.lastError);
    } finally {
      this.running = false;
    }

    if (due.length > 1) {
      setTimeout(() => this.tick(), 1000);
    }
  }
}
