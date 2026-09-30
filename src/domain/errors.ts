export class WorkflowError extends Error {
  code: string;
  constructor(message: string, code = 'invalid_action') {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}
