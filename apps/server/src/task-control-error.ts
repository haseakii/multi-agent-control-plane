export class TaskControlError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'TaskControlError';
  }
}
