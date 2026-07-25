/**
 * Screenshot capture for the visual lane.
 *
 * The lane's assertions read numbers out of a real cascade, which is what makes
 * them trustworthy and also what makes a failure hard to picture: "resolved to
 * rgb(242, 222, 222)" does not tell you the menu looked pink. These images are
 * the missing half — they let a human check what the assertion was pointed at,
 * and let both themes be compared by scrolling a directory.
 *
 * Off by default. Images are a debugging aid, not an artifact the gate reads:
 * nothing here is ever compared against a golden image, which is the line
 * ADR-010 drew and this lane keeps.
 *
 *   INTELLIG_VISUAL_SHOTS=1   save a PNG per spec
 *   INTELLIG_VISUAL_HEADED=1  run a visible browser (implies a slow-motion delay)
 *
 * Output goes to workspace-notes/visual-shots/, which is gitignored.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright-core';

const SHOTS_DIR = path.resolve(__dirname, '../../../workspace-notes/visual-shots');

let currentTestName = 'unknown';

export function setCurrentTestName(name: string): void {
  currentTestName = name;
}

export function shotsEnabled(): boolean {
  return process.env.INTELLIG_VISUAL_SHOTS === '1';
}

export function headedEnabled(): boolean {
  return process.env.INTELLIG_VISUAL_HEADED === '1';
}

/** Without a delay 16 specs flash past in seconds and headed mode shows nothing. */
export function slowMoMs(): number {
  return headedEnabled() ? Number(process.env.INTELLIG_VISUAL_SLOWMO ?? '250') : 0;
}

function fileNameFor(suffix: string): string {
  const base = currentTestName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return `${base}${suffix}.png`;
}

/**
 * Clips to what was actually rendered, plus a margin.
 *
 * A menu anchored near the origin of a 1280x800 viewport is a few percent of
 * the frame; an unclipped shot is mostly empty background and useless for
 * comparing two themes at a glance.
 */
async function contentClip(page: Page): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
} | null> {
  return page.evaluate(() => {
    const boxes = [...document.body.querySelectorAll('*')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    if (boxes.length === 0) {
      return null;
    }
    const margin = 16;
    const left = Math.max(0, Math.min(...boxes.map((b) => b.left)) - margin);
    const top = Math.max(0, Math.min(...boxes.map((b) => b.top)) - margin);
    const right = Math.min(window.innerWidth, Math.max(...boxes.map((b) => b.right)) + margin);
    const bottom = Math.min(window.innerHeight, Math.max(...boxes.map((b) => b.bottom)) + margin);
    const width = right - left;
    const height = bottom - top;
    return width > 0 && height > 0 ? { x: left, y: top, width, height } : null;
  });
}

/**
 * Saves a shot of the current page. `suffix` distinguishes a failure capture
 * from the ordinary one so a failing spec leaves both.
 *
 * Never throws: a capture problem must not turn a passing spec red, and must
 * not mask the real assertion error on a failing one.
 */
export async function saveShot(page: Page, suffix = ''): Promise<string | undefined> {
  try {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const file = path.join(SHOTS_DIR, fileNameFor(suffix));
    const clip = await contentClip(page);
    await page.screenshot(clip ? { path: file, clip } : { path: file });
    return file;
  } catch {
    return undefined;
  }
}

export function shotsDirectory(): string {
  return SHOTS_DIR;
}
