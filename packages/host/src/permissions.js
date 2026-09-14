import { app, desktopCapturer, shell, systemPreferences } from 'electron';

/**
 * macOS privacy permissions.
 *
 * This is the riskiest moment in the whole product: a non-technical
 * person, already dealing with a broken computer, is asked to open
 * System Settings and grant two permissions to software they installed
 * five minutes ago. Neither can be granted programmatically — the OS
 * only allows deep-linking to the right pane — and Screen Recording
 * additionally does not take effect until the app restarts.
 *
 * So the agent's job is to know exactly which of the two is missing at
 * any moment, say so in plain language, open the correct pane, and
 * offer the restart itself rather than describing one.
 */

const PANE = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};

export const NEEDS_PERMISSIONS = process.platform === 'darwin';

/**
 * Screen Recording is only read by macOS at process start, so a
 * permission granted while the agent is running does nothing until it
 * restarts. Remembering the value from boot is the only way to tell
 * "already working" apart from "granted, pending restart" — and getting
 * that wrong means offering a pointless restart, or failing to offer a
 * necessary one.
 */
let bootScreenState = null;

/**
 * @returns {{screen: boolean, accessibility: boolean, ok: boolean,
 *            canControl: boolean, needsRelaunch: boolean, platform: string}}
 */
export function checkPermissions() {
  if (!NEEDS_PERMISSIONS) {
    return {
      screen: true,
      accessibility: true,
      ok: true,
      canControl: true,
      needsRelaunch: false,
      platform: process.platform,
    };
  }

  const screen = systemPreferences.getMediaAccessStatus('screen') === 'granted';

  // Passing false checks without prompting. The prompt is triggered
  // deliberately from requestAccessibility(), so the agent never throws
  // a system dialog at someone who has not asked for one yet.
  const accessibility = systemPreferences.isTrustedAccessibilityClient(false);

  if (bootScreenState === null) bootScreenState = screen;

  return {
    screen,
    accessibility,

    // Screen Recording is the only hard requirement: without it there
    // is nothing to show and no session worth starting. Accessibility
    // is what upgrades watching into working, so its absence downgrades
    // the session rather than blocking it — a specialist who can see
    // the problem is still far more use than one who cannot connect.
    ok: screen,
    canControl: accessibility,

    needsRelaunch: screen && bootScreenState === false,
    platform: process.platform,
  };
}

/**
 * Triggers the system's own Accessibility prompt.
 *
 * Unlike Screen Recording, this one takes effect immediately once
 * granted — no restart needed — so it is worth prompting for directly.
 */
export function requestAccessibility() {
  if (!NEEDS_PERMISSIONS) return true;
  return systemPreferences.isTrustedAccessibilityClient(true);
}

export async function openPermissionPane(which) {
  if (!NEEDS_PERMISSIONS) return;
  const url = PANE[which];
  if (!url) return;

  // macOS lists an app under Screen Recording only once it has actually
  // tried to capture. Opening the pane without doing that first sends
  // the client to a list their app is simply not in — nothing to switch
  // on, and no way for them to know why. So provoke the attempt, which
  // is what registers the app, and only then open the settings.
  if (which === 'screen') {
    try {
      await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
      });
    } catch {
      /* refusal is the expected outcome; registering is the point */
    }
  }

  await shell.openExternal(url);
}

/**
 * Screen Recording is only re-read at process start, so a freshly
 * granted permission does nothing until the agent restarts itself.
 */
export function relaunch() {
  app.relaunch();
  // quit(), not exit(0). exit skips will-quit, and will-quit is where
  // the injector is disabled and the session log is closed.
  app.quit();
}

export function permissionCopy(state) {
  if (state.screen && state.accessibility) return null;

  if (!state.screen && !state.accessibility) {
    return {
      title: 'Two permissions are needed',
      body: 'macOS has to let Desky show your screen and move your pointer. Turn on both switches — you only do this once.',
      missing: ['screen', 'accessibility'],
      blocking: true,
    };
  }

  if (!state.screen) {
    return {
      title: 'Screen Recording permission is needed',
      body: 'Without it nobody can see your screen, and the connection will not start.',
      missing: ['screen'],
      blocking: true,
    };
  }

  return {
    title: 'They will only be able to watch',
    body: 'Permission to control this computer has not been given. They can still connect and see your screen, but they cannot move the pointer or type — they will talk you through it and you do the clicking.',
    missing: ['accessibility'],
    blocking: false,
  };
}
