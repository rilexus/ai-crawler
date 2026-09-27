const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class WorkerPool {
  #concurrentTasks;
  #defaultDelay;
  #queue = [];

  /**
   * @param {object} options
   * @param {number} options.concurrentTasks Maximum number of tasks running at once.
   * @param {number} [options.delay=0] Default delay in milliseconds before each task starts.
   */
  constructor({ concurrentTasks, delay = 0 }) {
    this.#concurrentTasks = concurrentTasks;
    this.#defaultDelay = delay;
  }

  /**
   * Queues a task.
   *
   * @param {() => Promise<any>} task
   * @param {number} [delay] Milliseconds to wait before the task starts. The
   *   wait occupies the worker slot, so it also spaces out tasks on that
   *   worker. Falls back to the pool's default delay.
   */
  addTask(task, delay = this.#defaultDelay) {
    if (!Number.isFinite(delay) || delay < 0) {
      throw new RangeError(`Invalid task delay: ${delay}`);
    }
    this.#queue.push({ task, delay });
  }

  async execute() {
    const queue = this.#queue;
    this.#queue = [];
    const results = new Array(queue.length);

    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const index = cursor++;
        const { task, delay } = queue[index];
        try {
          if (delay > 0) await sleep(delay);
          results[index] = { status: "fulfilled", value: await task() };
        } catch (error) {
          results[index] = { status: "rejected", reason: error };
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(this.#concurrentTasks, queue.length) },
      worker,
    );
    await Promise.all(workers);

    return results;
  }
}

module.exports = WorkerPool;
