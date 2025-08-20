/**
 * Manages the automatic painting process.
 * @class AutoPainter
 * @since 0.83.0
 */
export default class AutoPainter {
  constructor() {
    this.isPainting = false; // Initial state is off
    this.isCooldown = false;
    this.resolveQuickPaint = null; // A function to resolve the promise once quick paint is done.

    // New: failure tracking for automatic reload
    this.failureCount = 0;
    this.failureThreshold = 3; // Reload the page after this many consecutive failures

    // (No explicit interval stored here; we read it from the UI/localStorage each cycle.)
  }

  /**
   * Starts the auto-painting process. This should be called when the checkbox is checked.
   * It will only truly start if a template is loaded.
   */
  start() {
    // The actual painting loop will only run if this.isPainting is true AND a template is available.
    // The UI (main.js) will set this.isPainting based on the checkbox.
    if (!this.isPainting) { // Only log if we are actually transitioning to 'started'
      console.log('%cBlue Marble%c: [Auto Painter] Started.', 'color: cornflowerblue;', '');
      this.isPainting = true;
      this.failureCount = 0; // Reset failure counter when starting
      try {
        localStorage.setItem('bm-autopaint-enabled', 'true');
      } catch (e) {
        // Ignore storage errors
      }
      this.paintCycle(); // Start the loop
    }
  }

  /**
   * Stops the auto-painting process. This should be called when the checkbox is unchecked.
   */
  stop() {
    if (this.isPainting) { // Only log if we are actually transitioning to 'stopped'
      console.log('%cBlue Marble%c: [Auto Painter] Stopping.', 'color: cornflowerblue;', '');
      this.isPainting = false; // This flag will break the paintCycle loop
      try {
        localStorage.setItem('bm-autopaint-enabled', 'false');
      } catch (e) {
        // Ignore storage errors
      }
    }
  }

  /**
   * Acknowledges that the quick paint network request has finished,
   * allowing the paint cycle to proceed to the cooldown phase.
   */
  onQuickPaintFinished() {
    if (this.resolveQuickPaint) {
      try {
        this.resolveQuickPaint();
      } catch (e) {
        // ignore
      }
      this.resolveQuickPaint = null; // Reset for the next cycle.
    }
    // Reset failure counter on success
    this.failureCount = 0;
  }

/**
 * Waits for an element to be present and physically clickable (not obscured).
 * @param {string} selector - The CSS selector for the element.
 * @param {number} timeout - The maximum time to wait in milliseconds.
 * @returns {Promise<Element>} - A promise that resolves with the element when it's ready.
 */
waitForElementToBeClickable(selector, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const interval = setInterval(() => {
            // If isPainting flag is false, immediately reject to stop waiting
            if (!this.isPainting) {
                clearInterval(interval);
                reject(new Error(`[Auto Painter] Operation cancelled by user.`));
                return;
            }

            const overlayElement = document.querySelector('#bm-overlay');
            let originalDisplayStyle;
            if (overlayElement) {
                originalDisplayStyle = overlayElement.style.display;
                overlayElement.style.display = 'none';
            }

            let elementToResolve = null;

            try {
                const element = document.querySelector(selector);

                if (element) {
                    const rect = element.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        const centerX = rect.left + rect.width / 2;
                        const centerY = rect.top + rect.height / 2;
                        const topElement = document.elementFromPoint(centerX, centerY);

                        if (topElement === element || element.contains(topElement)) {
                            elementToResolve = element;
                        }
                    }
                }
            } finally {
                if (overlayElement) {
                    overlayElement.style.display = originalDisplayStyle;
                }
            }

            if (elementToResolve) {
                clearInterval(interval);
                resolve(elementToResolve);
                return;
            }

            if (Date.now() - startTime > timeout) {
                clearInterval(interval);
                reject(new Error(`[Auto Painter] Element "${selector}" was not clickable within ${timeout}ms. It might be obscured.`));
            }
        }, 500);
    });
}

  /**
   * Helper: read the autopaint interval (in ms) from the UI or localStorage.
   * Checks #bm-input-autopaint-interval first, then localStorage fallback, returns ms (number).
   */
  getIntervalMs() {
    try {
      const input = document.querySelector('#bm-input-autopaint-interval');
      let raw;
      if (input && typeof input.value !== 'undefined' && input.value !== '') {
        raw = input.value;
      } else {
        raw = localStorage.getItem('bm-autopaint-interval') || '0';
      }
      const seconds = parseFloat(raw);
      if (isNaN(seconds) || seconds < 0) return 0;
      return Math.round(seconds * 1000);
    } catch (e) {
      return 0;
    }
  }

  /**
   * Helper: wait for up to ms milliseconds, but return early if this.isPainting becomes false.
   * Returns true if waited the full duration, false if aborted because painting was stopped.
   */
  async waitUnlessStopped(ms) {
    const chunk = 300;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!this.isPainting) return false;
      const remaining = Math.min(chunk, end - Date.now());
      await new Promise(r => setTimeout(r, remaining));
    }
    return true;
  }

  /**
   * The main function that performs the painting sequence and handles the loop.
   */
  async paintCycle() {
    while (this.isPainting) { // Loop continues as long as this.isPainting is true
      console.log("[Auto Painter] Starting a new paint cycle...");
      try {
        const canvas = document.querySelector('canvas.maplibregl-canvas');
        if (!canvas) {
          console.error("[Auto Painter] Canvas not found. Retrying in 5 seconds...");
          // brief non-blocking wait but allow early cancellation
          const ok = await this.waitUnlessStopped(5000);
          if (!ok) break;
          continue; // Continue to the next iteration of the loop
        }

        // Wait for the main paint button to be clickable, which also handles the cooldown period.
        console.log("[Auto Painter] Waiting for cooldown to finish...");
        const initialPaintButton = await this.waitForElementToBeClickable('div[class*="bottom-3"] button.btn-primary', 60000); // Wait up to 1 minute
        console.log("[Auto Painter] Cooldown finished. Starting paint sequence.");

        // Step 1: Click the initial "Paint" button
        initialPaintButton.click();
        console.log("[Auto Painter] Step 1: Initial paint button clicked.");

        // Step 2: Select "Transparent" color (to ensure a paint action is sent without wasting color)
        console.log("[Auto Painter] Step 2: Waiting for 'Transparent' color button...");
        const transparentColorButton = await this.waitForElementToBeClickable('#color-0');
        transparentColorButton.click();
        console.log("[Auto Painter] Step 2: Transparent color selected.");

        // Step 3: Click the dead center of the canvas
        const rect = canvas.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const clickEvent = new MouseEvent('click', { clientX: centerX, clientY: centerY, bubbles: true });
        canvas.dispatchEvent(clickEvent);
        console.log(`[Auto Painter] Step 3: Canvas clicked at its center.`);

        // Create a promise that will be resolved by onQuickPaintFinished
        const quickPaintPromise = new Promise(resolve => {
          this.resolveQuickPaint = resolve;
        });

        // Create a cancellation promise which rejects if painting is stopped
        let cancellationInterval = null;
        const cancellationPromise = new Promise((_, reject) => {
          cancellationInterval = setInterval(() => {
            if (!this.isPainting) {
              clearInterval(cancellationInterval);
              reject(new Error('[Auto Painter] Operation cancelled by user.'));
            }
          }, 200);
        });

        // Step 4: Click the final "Paint" button, which will trigger the Quick Paint interception
        console.log("[Auto Painter] Step 4: Waiting for final 'Paint' button...");
        const finalPaintButton = await this.waitForElementToBeClickable('div[class*="left-1/2"] button.btn-primary');
        finalPaintButton.click();
        console.log("[Auto Painter] SUCCESS: Final paint button clicked. Waiting for Quick Paint response...");

        // Wait for the quick paint process to complete, or be cancelled
        try {
          await Promise.race([quickPaintPromise, cancellationPromise]);
        } finally {
          if (cancellationInterval) {
            clearInterval(cancellationInterval);
            cancellationInterval = null;
          }
        }

        console.log("[Auto Painter] Quick Paint response received. Cycle finished.");

        // Successful cycle: reset failure counter
        this.failureCount = 0;

        // Wait user-configured interval between cycles (cancellable)
        const ms = this.getIntervalMs();
        if (ms > 0) {
          // Pause network activities for the duration of the interval.
          // We set a localStorage flag that the injected/page fetch/XHR overrides will check.
          try {
            localStorage.setItem('bm-network-paused', 'true');
            console.log('[Auto Painter] Network paused for interval.');
          } catch (e) {
            // ignore storage set errors
          }

          const waited = await this.waitUnlessStopped(ms);
          if (!waited) {
            console.log("[Auto Painter] Interval wait aborted because AutoPaint was stopped.");
            // Clear paused flag if stopping early
            try { localStorage.removeItem('bm-network-paused'); } catch (e) {}
            break;
          }

          // Interval finished; prepare for next cycle by reloading the page so it fetches fresh content.
          // Clear the pause flag on the current storage so the new load will start with network enabled.
          try {
            localStorage.removeItem('bm-network-paused');
            console.log('[Auto Painter] Clearing network pause and reloading page to start next cycle.');
          } catch (e) {
            // ignore
          }

          try {
            // Attempt to reload the page to ensure a clean start for the next cycle.
            window.location.reload();
          } catch (e) {
            try { location.reload(); } catch (_) { /* ignore */ }
          }

          // After reload call, execution will stop here as page is navigating away.
          break;
        }

      } catch (error) {
        if (!this.isPainting) {
            console.log("[Auto Painter] Operation stopped externally.");
            break; // Exit loop if stopped by user or external event
        }

        this.failureCount = (this.failureCount || 0) + 1;
        console.error("[Auto Painter] Painting failed:", error.message || error);
        console.log(`[Auto Painter] Consecutive failures: ${this.failureCount}/${this.failureThreshold}`);

        if (this.failureCount >= this.failureThreshold) {
          console.error("[Auto Painter] Reached consecutive failure threshold. Reloading page to recover...");
          try {
            // Attempt to reload the page to recover from persistent failures
            // Note: a beforeunload bypass is injected in the page to reduce the chance of prompts blocking reload.
            window.location.reload();
          } catch (e) {
            try { location.reload(); } catch (e2) { /* ignore */ }
          }
          break;
        }

        console.log("[Auto Painter] Retrying in 10 seconds...");
        try {
            localStorage.setItem('bm-network-paused', 'true');
            console.log('[Auto Painter] Network paused for retry.');
        } catch (e) {
            // ignore storage set errors
        }

        const ok = await this.waitUnlessStopped(10000); // Wait before retrying
        
        try {
            localStorage.removeItem('bm-network-paused');
            console.log('[Auto Painter] Network unpaused after retry wait.');
        } catch (e) {
            // ignore storage remove errors
        }

        if (!ok) break;
      }
    }
    // Loop has ended, ensure isPainting is false if it wasn't already set
    this.isPainting = false;
  }
}