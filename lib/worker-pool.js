class WorkerPool {
  #concurrentTasks;
  #queue = [];

  constructor({ concurrentTasks }) {
    this.#concurrentTasks = concurrentTasks;
  }

  addTask(task) {
    this.#queue.push(task);
  }

  async execute() {
    const queue = this.#queue;
    this.#queue = [];
    const results = new Array(queue.length);

    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const index = cursor++;
        try {
          results[index] = { status: "fulfilled", value: await queue[index]() };
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
