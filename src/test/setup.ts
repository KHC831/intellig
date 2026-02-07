/**
 * Test setup file that mocks the VS Code module.
 * This file is loaded before tests run to provide mock implementations
 * of VS Code APIs that are not available outside the extension host.
 */

/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/unbound-method */

import * as Module from 'module';
import * as path from 'path';

// Path to our mock vscode module
const mockVscodePath = path.resolve(__dirname, 'mocks/vscode');

// Store the original require function
const originalRequire = Module.prototype.require;

// Override require to intercept 'vscode' module requests
(Module.prototype as any).require = function (this: NodeModule, id: string): unknown {
  if (id === 'vscode') {
    // Return our mock instead of the real vscode module
    return originalRequire.call(this, mockVscodePath) as unknown;
  }
  return originalRequire.call(this, id) as unknown;
};

// Export the mock for direct use in tests if needed
export * from './mocks/vscode';
