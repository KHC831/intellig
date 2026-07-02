// Substitute for IntelliJ's com.intellij.openapi.progress.ProcessCanceledException,
// the base class the diff engine's cancellation and too-big guards throw.

export class ProcessCanceledException extends Error {
  constructor(message: string = 'Process canceled') {
    super(message);
    this.name = new.target.name;
  }
}
