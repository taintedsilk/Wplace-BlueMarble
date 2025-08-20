/** @file The main file. Everything in the userscript is executed from here.
 * @since 0.0.0
 */

import Overlay from './Overlay.js';
import Observers from './observers.js';
import ApiManager from './apiManager.js';
import TemplateManager from './templateManager.js';
import AutoPainter from './autoPainter.js'; // Import the new AutoPainter
import { consoleLog, consoleWarn, colorpalette } from './utils.js';

const name = GM_info.script.name.toString(); // Name of userscript
const version = GM_info.script.version.toString(); // Version of userscript
const consoleStyle = 'color: cornflowerblue;'; // The styling for the console logs

/** Injects code into the client
 * This code will execute outside of TamperMonkey's sandbox
 * @param {*} callback - The code to execute
 * @since 0.11.15
 */
function inject(callback) {
    const script = document.createElement('script');
    script.setAttribute('bm-name', name); // Passes in the name value
    script.setAttribute('bm-cStyle', consoleStyle); // Passes in the console style value
    script.textContent = `(${callback})();`;
    document.documentElement?.appendChild(script);
    script.remove();
}

// Ensure any leftover network-pause flag is cleared on fresh script start (so network is allowed).
// This is important because AutoPainter sets 'bm-network-paused' during the wait interval and then reloads.
// Clearing here ensures a new page / new userscript run will allow network again by default.
try {
  localStorage.removeItem('bm-network-paused');
} catch (e) {
  // ignore storage errors
}

// --- In main.js ---

/** What code to execute instantly in the client (webpage) to spy on fetch calls.
 * This code will execute outside of TamperMonkey's sandbox.
 * @since 0.11.15
 */
inject(() => {

  const script = document.currentScript;
  const name = script?.getAttribute('bm-name') || 'Blue Marble';
  const consoleStyle = script?.getAttribute('bm-cStyle') || '';
  const fetchedBlobQueue = new Map();

  // Add a beforeunload bypass in the page context (capture phase) to try to prevent other handlers from blocking programmatic reloads.
  // User requested: window.addEventListener('beforeunload', function (event) { event.stopImmediatePropagation(); });
  try {
    window.addEventListener('beforeunload', function (event) {
      try {
        event.stopImmediatePropagation();
      } catch (e) {
        // ignore
      }
    }, true);
  } catch (e) {
    // ignore
  }

  // Listener for PROCESSED blobs from the userscript
  window.addEventListener('message', (event) => {
    const data = event['data'];
    if (data && data['source'] === 'blue-marble' && data['blobID'] && !data['endpoint']) {
      const callback = fetchedBlobQueue.get(data['blobID']);
      if (typeof callback === 'function') {
        callback(data['blobData']); // Resolve the promise with the new blob
      } else {
        console.warn(`%cBlue Marble%c: [INJECT] Could not find callback for blobID: ${data['blobID']}`, 'color: cornflowerblue;', '');
      }
      fetchedBlobQueue.delete(data['blobID']);
    }
  });

  const originalFetch = window.fetch;

  // Override XMLHttpRequest send/open to respect bm-network-paused
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      try {
        this._bm_open_method = method;
        this._bm_open_url = url;
      } catch (e) {}
      return origOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function(body) {
      try {
        const networkPaused = localStorage.getItem('bm-network-paused') === 'true';
        if (networkPaused) {
          // Log once for debugging purposes, but avoid spamming
          // We intentionally block the send by not calling the original send.
          // This effectively pauses XHR network activity until the page is reloaded.
          // Note: some callers may expect a response; they may hang. This is intentional per pause request.
          // A future enhancement could queue XHRs instead of dropping them.
          // console.log(`${name}: [INJECT] XHR blocked due to network pause: ${this._bm_open_method} ${this._bm_open_url}`);
          return;
        }
      } catch (e) {
        // If reading storage fails, fallback to normal send
      }
      return origSend.apply(this, [body]);
    };
  } catch (e) {
    // If XMLHttpRequest is not available or overriding fails, ignore.
  }

  // Overridden fetch function
  window.fetch = async function(...args) {
    const request = new Request(args[0], args[1]);

    // If autopaint put the network into a paused state, block fetch requests by returning a never-resolving Promise.
    // This effectively pauses network activity until the flag is cleared and/or the page reloads.
    try {
      const networkPaused = localStorage.getItem('bm-network-paused') === 'true';
      if (networkPaused) {
        // Return a Promise that never resolves to pause the network call.
        // We intentionally avoid rejecting so calling code may hang (consistent with "pause" semantics).
        // Avoid logging every blocked fetch to reduce noise.
        return new Promise(() => {});
      }
    } catch (e) {
      // If storage access fails, continue normally
    }

    const isQuickPaintEnabled = localStorage.getItem('bm-quick-paint-enabled') === 'true';

    if (isQuickPaintEnabled && request.method === 'POST' && request.url.includes('/s0/pixel/')) {
        try {
            const clonedRequest = request.clone();
            const body = await clonedRequest.json();

            if (body && body['t']) {
                console.log(`%cBlue Marble%c: [Quick Paint] Valid paint token found! Forwarding to userscript.`, 'color: cornflowerblue;', '');

                window.postMessage({
                    'source': 'blue-marble',
                    'action': 'executeQuickPaint',
                    'token': body['t']
                }, '*');

                // Block the original request, let Quick Paint handle it
                return new Promise(() => {}); 

            }
        } catch (e) {
            // Silently fail if it's not the request we are looking for.
        }
    }

    const response = await originalFetch.apply(this, [request]);
    const clonedResponse = response.clone();
    const endpointName = request.url;
    const contentType = clonedResponse.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      clonedResponse.json().then(jsonData => {
        window.postMessage({
          'source': 'blue-marble',
          'endpoint': endpointName,
          'jsonData': jsonData
        }, '*');
      }).catch(err => {
        // Error is fine, not all json responses are valid
      });

    } else if (contentType.includes('image/') && !endpointName.includes('openfreemap') && !endpointName.includes('maps')) {
      return new Promise(async (resolve) => {
        try {
          const blob = await clonedResponse.blob();
          const blobUUID = crypto.randomUUID();

          fetchedBlobQueue.set(blobUUID, (processedBlob) => {
            resolve(new Response(processedBlob, {
              headers: clonedResponse.headers,
              status: clonedResponse.status,
              statusText: clonedResponse.statusText
            }));
          });

          window.postMessage({
            'source': 'blue-marble',
            'endpoint': endpointName,
            'blobID': blobUUID,
            'blobData': blob,
            'blink': Date.now()
          });

        } catch (e) {
          resolve(response);
        }
      });
    }

    return response;
  };
});

// ... (The rest of the main.js file, constructors, etc., remains exactly the same) ...
// Embed the CSS directly into the script
const cssOverlay = `
/* @since 0.5.1 */

/* The entire overlay */
#bm-overlay {
  position: fixed;
  background-color: rgba(21, 48, 99, 0.9);
  color: white;
  padding: 10px;
  border-radius: 8px;
  z-index: 9000;
  transition: all 0.3s ease, transform 0s;
  max-width: 300px;
  width: auto;
  /* Performance optimizations for smooth dragging */
  will-change: transform;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  transform-style: preserve-3d;
  -webkit-transform-style: preserve-3d;
}

/* Smooth transitions for minimize/maximize functionality */
#bm-contain-userinfo,
#bm-overlay hr,
#bm-contain-automation, 
#bm-contain-buttons-action {
  transition: opacity 0.2s ease, height 0.2s ease;
}

/* The entire overlay BUT it is cascading */
div#bm-overlay {
  /* Font stack is as follows:
   * Highest Priority (Roboto Mono)
   * Windows fallback (Courier New)
   * macOS fallback (Monaco)
   * Linux fallback (DejaVu Sans Mono)
   * Any possible monospace font (monospace)
   * Last resort (Arial) */
  font-family: 'Roboto Mono', 'Courier New', 'Monaco', 'DejaVu Sans Mono', monospace, 'Arial';
  letter-spacing: 0.05em;
}

/* The drag bar */
#bm-bar-drag {
  margin-bottom: 0.5em;
  /* For background circles, width & height should be odd, cx & cy should be half of width & height, and r should be less than or equal to cx & cy */
  background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"><circle cx="3" cy="3" r="1.5" fill="CornflowerBlue" /></svg>') repeat;
  cursor: grab;
  width: 100%;
  height: 1em;
}

/* When the overlay is being dragged */
#bm-bar-drag.dragging {
  cursor: grabbing;
}

/* Disable interactions during drag for better performance */
#bm-overlay:has(#bm-bar-drag.dragging) {
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
}

/* Keep drag bar interactive when dragging */
#bm-bar-drag.dragging {
  pointer-events: auto;
}

/* The container for the overlay header */
#bm-contain-header {
  margin-bottom: 0.5em;
}

/* When minimized, adjust header container */
#bm-contain-header[style*="text-align: center"] {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

/* Ensure overlay maintains consistent width when minimized */
#bm-overlay[style*="padding: 5px"] {
  width: auto !important;
  max-width: 300px;
  min-width: 200px;
}

/* The Blue Marble image */
#bm-overlay img {
  display: inline-block;
  height: 2.5em;
  margin-right: 1ch;
  vertical-align: middle;
  transition: opacity 0.2s ease;
}

/* When overlay is minimized, adjust image styling */
#bm-contain-header[style*="text-align: center"] img {
  margin-right: 0;
  margin-left: 0;
  display: block;
  margin: 0 auto;
}

/* Ensure drag bar remains functional when minimized */
#bm-bar-drag {
  transition: margin-bottom 0.2s ease;
}

/* The Blue Marble header */
#bm-overlay h1 {
  display: inline-block;
  font-size: x-large;
  font-weight: bold;
  vertical-align: middle;
}

/* Checkboxes in the automation container */
#bm-contain-automation input[type="checkbox"] {
  vertical-align: middle;
  margin-right: 0.5ch;
}

/* Checkbox label/flavor text in the automation container */
#bm-contain-automation label {
  margin-right: 0.5ch;
}

/* Question Mark button */
.bm-help {
  border: white 1px solid;
  height: 1.5em;
  width: 1.5em;
  margin-top: 2px;
  text-align: center;
  line-height: 1em;
  padding: 0 !important; /* Overrides the padding in "#bm-overlay button" */
}

/* Pin button */
#bm-button-coords {
  vertical-align: middle;
}

/* Pin button image*/
#bm-button-coords svg {
  width: 50%;
  margin: 0 auto;
  fill: #111;
}

/* Container for action buttons, that is inside the action button container */
div:has(> #bm-button-teleport) {
  display: flex;
  gap: 0.5ch;
}

/* Favorite (Star) button image */
/* Templates (Person) button image */
#bm-button-favorite svg,
#bm-button-template svg {
  height: 1em;
  margin: 0 auto;
  margin-top: 2px;
  text-align: center;
  line-height: 1em;
  vertical-align: bottom;
}

/* Tile (x, y) & Pixel (x, y) input fields */
#bm-contain-coords input[type="number"] {
  appearance: auto;
  -moz-appearance: textfield;
  width: 5.5ch;
  margin-left: 1ch;
  background-color: rgba(0, 0, 0, 0.2);
  padding: 0 0.5ch;
  font-size: small;
}

/* Removes scroll bar on tile & pixel input fields */
#bm-contain-coords input[type="number"]::-webkit-outer-spin-button,
#bm-contain-coords input[type="number"]::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

/* Automation button container */
#bm-contain-buttons-template {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-content: center;
  justify-content: center;
  align-items: center;
  gap: 1ch;
}

/* The template file upload button */
div:has(> #bm-input-file-template) > button {
  width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Force complete invisibility of file input to prevent native browser text */
#bm-input-file-template,
input[type="file"][id*="template"] {
  display: none !important;
  visibility: hidden !important;
  position: absolute !important;
  left: -9999px !important;
  top: -9999px !important;
  width: 0 !important;
  height: 0 !important;
  opacity: 0 !important;
  z-index: -9999 !important;
  pointer-events: none !important;
}

/* Output status area */
#bm-output-status {
  font-size: small;
  background-color: rgba(0, 0, 0, 0.2);
  padding: 0 0.5ch;
  height: 3.75em;
  width: 100%;
}

/* The action buttons below the status textarea */
#bm-contain-buttons-action {
  display: flex;
  justify-content: space-between;
}

/* All small elements */
#bm-overlay small {
  font-size: x-small;
  color: lightgray;
}

/* The elements that need spacing from each-other */
#bm-contain-userinfo,
#bm-contain-automation,
#bm-contain-coords,
#bm-contain-buttons-template,
div:has(> #bm-input-file-template),
#bm-output-status {
  margin-top: 0.5em;
}

/* All overlay buttons */
#bm-overlay button {
  background-color: #144eb9;
  border-radius: 1em;
  padding: 0 0.75ch;
}

/* All overlay buttons when hovered/focused */
#bm-overlay button:hover, #bm-overlay button:focus-visible {
  background-color: #1061e5;
}

/* All overlay buttons when pressed (plus disabled color) */
#bm-overlay button:active,
#bm-overlay button:disabled {
  background-color: #2e97ff;
}

/* All overlay buttons when disabled */
#bm-overlay button:disabled {
  text-decoration: line-through;
}
`;
GM_addStyle(cssOverlay);

// Imports the Roboto Mono font family
var stylesheetLink = document.createElement('link');
stylesheetLink.href = 'https://fonts.googleapis.com/css2?family=Roboto+Mono:ital,wght@0,100..700;1,100..700&display=swap';
stylesheetLink.rel = 'preload';
stylesheetLink.as = 'style';
stylesheetLink.onload = function () {
  this.onload = null;
  this.rel = 'stylesheet';
};
document.head?.appendChild(stylesheetLink);

// CONSTRUCTORS
const observers = new Observers(); // Constructs a new Observers object
const overlayMain = new Overlay(name, version); // Constructs a new Overlay object for the main overlay
const overlayTabTemplate = new Overlay(name, version); // Constructs a Overlay object for the template tab
const autoPainter = new AutoPainter(); // Construct the new AutoPainter
const templateManager = new TemplateManager(name, version, overlayMain, autoPainter); // Pass painter to TemplateManager
const apiManager = new ApiManager(templateManager, autoPainter); // Pass painter to ApiManager

overlayMain.setApiManager(apiManager); // Sets the API manager
overlayMain.setAutoPainter(autoPainter); // Set the AutoPainter instance on the overlay

const storageTemplates = JSON.parse(GM_getValue('bmTemplates', '{}'));
templateManager.importJSON(storageTemplates); // Loads the templates

buildOverlayMain(); // Builds the main overlay

// Add a userscript-context beforeunload bypass as well (redundant but sometimes helpful)
try {
  window.addEventListener('beforeunload', function (event) {
    try {
      event.stopImmediatePropagation();
    } catch (e) {
      // ignore
    }
  }, true);
} catch (e) {
  // ignore
}

const quickPaintCheckbox = document.querySelector('#bm-input-quick-paint');
const paintCountInput = document.querySelector('#bm-input-paint-count');
const autoPaintCheckbox = document.querySelector('#bm-input-autopaint'); // Get the new auto-paint checkbox
const autoPaintIntervalInput = document.querySelector('#bm-input-autopaint-interval');

if (quickPaintCheckbox) {
    quickPaintCheckbox.addEventListener('change', (event) => {
        localStorage.setItem('bm-quick-paint-enabled', event.target.checked);
    });
    // Initialize from localStorage
    quickPaintCheckbox.checked = localStorage.getItem('bm-quick-paint-enabled') === 'true';
}

// AutoPaint checkbox logic
if (autoPaintCheckbox) {
    autoPaintCheckbox.addEventListener('change', (event) => {
        localStorage.setItem('bm-autopaint-enabled', event.target.checked);
        if (event.target.checked) {
            // Start the painter. It will run but wait for a template to be available.
            autoPainter.start();
            overlayMain.handleDisplayStatus('AutoPaint enabled.');
        } else {
            autoPainter.stop();
            overlayMain.handleDisplayStatus('AutoPaint disabled.');
        }
    });
    // Initialize from localStorage
    const isAutoPaintEnabled = localStorage.getItem('bm-autopaint-enabled') === 'true';
    autoPaintCheckbox.checked = isAutoPaintEnabled;
    // If it was enabled on reload, start it. The painter will wait for a template to be loaded.
    if (isAutoPaintEnabled) {
        autoPainter.start();
        overlayMain.handleDisplayStatus('AutoPaint re-enabled from previous session.');
    }
}

// Interval input for auto-paint
if (autoPaintIntervalInput) {
    autoPaintIntervalInput.addEventListener('input', (event) => {
        // Store the interval in seconds
        localStorage.setItem('bm-autopaint-interval', event.target.value);
    });
    // Initialize from localStorage (default to 5 seconds if not set)
    autoPaintIntervalInput.value = localStorage.getItem('bm-autopaint-interval') || '5';
}

overlayMain.handleDrag('#bm-overlay', '#bm-bar-drag'); // Creates dragging capability on the drag bar for dragging the overlay

apiManager.spontaneousResponseListener(overlayMain); // Reads spontaneous fetch responces

observeBlack(); // Observes the black palette color

consoleLog(`%c${name}%c (${version}) userscript has loaded!`, 'color: cornflowerblue;', '');

/** Observe the black color, and add the "Move" button.
 * @since 0.66.3
 */
function observeBlack() {
  const observer = new MutationObserver((mutations, observer) => {

    const black = document.querySelector('#color-1'); // Attempt to retrieve the black color element for anchoring

    if (!black) {return;} // Black color does not exist yet. Kills iteself

    let move = document.querySelector('#bm-button-move'); // Tries to find the move button

    // If the move button does not exist, we make a new one
    if (!move) {
      move = document.createElement('button');
      move.id = 'bm-button-move';
      move.textContent = 'Move ↑';
      move.className = 'btn btn-soft';
      move.onclick = function() {
        const roundedBox = this.parentNode.parentNode.parentNode.parentNode; // Obtains the rounded box
        const shouldMoveUp = (this.textContent == 'Move ↑');
        roundedBox.parentNode.className = roundedBox.parentNode.className.replace(shouldMoveUp ? 'bottom' : 'top', shouldMoveUp ? 'top' : 'bottom'); // Moves the rounded box to the top
        roundedBox.style.borderTopLeftRadius = shouldMoveUp ? '0px' : 'var(--radius-box)';
        roundedBox.style.borderTopRightRadius = shouldMoveUp ? '0px' : 'var(--radius-box)';
        roundedBox.style.borderBottomLeftRadius = shouldMoveUp ? 'var(--radius-box)' : '0px';
        roundedBox.style.borderBottomRightRadius = shouldMoveUp ? 'var(--radius-box)' : '0px';
        this.textContent = shouldMoveUp ? 'Move ↓' : 'Move ↑';
      }

      // Attempts to find the "Paint Pixel" element for anchoring
      const paintPixel = black.parentNode.parentNode.parentNode.parentNode.querySelector('h2');

      paintPixel.parentNode?.appendChild(move); // Adds the move button
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

/** Deploys the overlay to the page with minimize/maximize functionality.
 * Creates a responsive overlay UI that can toggle between full-featured and minimized states.
 * 
 * Parent/child relationships in the DOM structure below are indicated by indentation.
 * @since 0.58.3
 */
function buildOverlayMain() {
  let isMinimized = false; // Overlay state tracker (false = maximized, true = minimized)
  
  overlayMain.addDiv({'id': 'bm-overlay', 'style': 'top: 10px; right: 75px;'})
    .addDiv({'id': 'bm-contain-header'})
      .addDiv({'id': 'bm-bar-drag'}).buildElement()
      .addImg({'alt': 'Blue Marble Icon - Click to minimize/maximize', 'src': 'https://raw.githubusercontent.com/SwingTheVine/Wplace-BlueMarble/main/dist/assets/Favicon.png', 'style': 'cursor: pointer;'}, 
        (instance, img) => {
          img.addEventListener('click', () => {
            isMinimized = !isMinimized; // Toggle the current state

            const overlay = document.querySelector('#bm-overlay');
            const header = document.querySelector('#bm-contain-header');
            const dragBar = document.querySelector('#bm-bar-drag');
            const coordsContainer = document.querySelector('#bm-contain-coords');
            const coordsButton = document.querySelector('#bm-button-coords');
            const createButton = document.querySelector('#bm-button-create');
            const enableButton = document.querySelector('#bm-button-enable');
            const disableButton = document.querySelector('#bm-button-disable');
            const autoPaintCheckbox = document.querySelector('#bm-input-autopaint'); // Get auto-paint checkbox
            const coordInputs = document.querySelectorAll('#bm-contain-coords input');
            
            if (!isMinimized) {
              overlay.style.width = "auto";
              overlay.style.maxWidth = "300px";
              overlay.style.minWidth = "200px";
              overlay.style.padding = "10px";
            }
            
            const elementsToToggle = [
              '#bm-overlay h1',
              '#bm-contain-userinfo',
              '#bm-overlay hr',
              '#bm-contain-automation > *:not(#bm-contain-coords)',
              '#bm-input-file-template',
              '#bm-contain-buttons-action',
              `#${instance.outputStatusId}`
            ];
            
            elementsToToggle.forEach(selector => {
              const elements = document.querySelectorAll(selector);
              elements.forEach(element => {
                element.style.display = isMinimized ? 'none' : '';
              });
            });
            if (isMinimized) {
              if (coordsContainer) {
                coordsContainer.style.display = 'none';
              }
              if (coordsButton) {
                coordsButton.style.display = 'none';
              }
              if (createButton) {
                createButton.style.display = 'none';
              }
              if (enableButton) {
                enableButton.style.display = 'none';
              }
              if (disableButton) {
                disableButton.style.display = 'none';
              }
              if (autoPaintCheckbox) { // Hide auto-paint checkbox
                autoPaintCheckbox.parentNode.style.display = 'none'; // Hide the label (parent) of the checkbox
              }
              coordInputs.forEach(input => {
                input.style.display = 'none';
              });
              overlay.style.width = '60px';
              overlay.style.height = '76px';
              overlay.style.maxWidth = '60px';
              overlay.style.minWidth = '60px';
              overlay.style.padding = '8px';
              img.style.marginLeft = '3px';
              header.style.textAlign = 'center';
              header.style.margin = '0';
              header.style.marginBottom = '0';
              if (dragBar) {
                dragBar.style.display = '';
                dragBar.style.marginBottom = '0.25em';
              }
            } else {
              if (coordsContainer) {
                coordsContainer.style.display = '';
                coordsContainer.style.flexDirection = '';
                coordsContainer.style.justifyContent = '';
                coordsContainer.style.alignItems = '';
                coordsContainer.style.gap = '';
                coordsContainer.style.textAlign = '';
                coordsContainer.style.margin = '';
              }
              if (coordsButton) {
                coordsButton.style.display = '';
              }
              if (createButton) {
                createButton.style.display = '';
                createButton.style.marginTop = '';
              }
              if (enableButton) {
                enableButton.style.display = '';
                enableButton.style.marginTop = '';
              }
              if (disableButton) {
                disableButton.style.display = '';
                disableButton.style.marginTop = '';
              }
              if (autoPaintCheckbox) { // Show auto-paint checkbox
                autoPaintCheckbox.parentNode.style.display = ''; // Show the label (parent) of the checkbox
              }
              coordInputs.forEach(input => {
                input.style.display = '';
              });
              img.style.marginLeft = '';
              overlay.style.padding = '10px';
              header.style.textAlign = '';
              header.style.margin = '';
              header.style.marginBottom = '';
              if (dragBar) {
                dragBar.style.marginBottom = '0.5em';
              }
              overlay.style.width = '';
              overlay.style.height = '';
            }
            img.alt = isMinimized ? 
              'Blue Marble Icon - Minimized (Click to maximize)' : 
              'Blue Marble Icon - Maximized (Click to minimize)';
          });
        }
      ).buildElement()
      .addHeader(1, {'textContent': name}).buildElement()
    .buildElement()

    .addHr().buildElement()

    .addDiv({'id': 'bm-contain-userinfo'})
      .addP({'id': 'bm-user-name', 'textContent': 'Username:'}).buildElement()
      .addP({'id': 'bm-user-droplets', 'textContent': 'Droplets:'}).buildElement()
      .addP({'id': 'bm-user-nextlevel', 'textContent': 'Next level in...'}).buildElement()
    .buildElement()

    .addHr().buildElement()

    .addDiv({'id': 'bm-contain-automation'})
      .addCheckbox({'id': 'bm-input-grief-clean', 'textContent': 'Grief-Clean', 'checked': false},
        (instance, checkbox) => {
          checkbox.addEventListener('change', () => {
            instance.apiManager?.templateManager?.setAnalyzeTransparentPixels(checkbox.checked);
          });
        }
      ).buildElement()
      .addButtonHelp({'title': 'When enabled, transparent pixels in your template will be targeted for removal if they have been colored in on the canvas. Useful for clearing vandalism.'}).buildElement()
      .addBr().buildElement()
      .addCheckbox({'id': 'bm-input-quick-paint', 'textContent': 'Quick Paint', 'checked': false}).buildElement()
      .addButtonHelp({'title': 'Automatically paints pixels from the template when you place a pixel.'}).buildElement()
      .addInput({'type': 'number', 'id': 'bm-input-paint-count', 'placeholder': 'Reserve', 'min': 0, 'value': 0, 'style': 'width: 6ch; margin-left: 1ch;'}).buildElement()
      .addBr().buildElement()
      // NEW AUTOPAINT CHECKBOX + INTERVAL INPUT
      .addCheckbox({'id': 'bm-input-autopaint', 'textContent': 'AutoPaint', 'checked': false}).buildElement()
      .addInput({'type': 'number', 'id': 'bm-input-autopaint-interval', 'placeholder': 'Interval (s)', 'min': 0, 'value': '5', 'style': 'width: 6ch; margin-left: 1ch;'}).buildElement()
      .addButtonHelp({'title': 'Automatically clicks the canvas and paint buttons to place pixels from the queue. Requires Quick Paint to be enabled.'}).buildElement()
      .addBr().buildElement()
      .addDiv({'id': 'bm-contain-coords'})
        .addButton({'id': 'bm-button-coords', 'className': 'bm-help', 'style': 'margin-top: 0;', 'innerHTML': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 6"><circle cx="2" cy="2" r="2"></circle><path d="M2 6 L3.7 3 L0.3 3 Z"></path><circle cx="2" cy="2" r="0.7" fill="white"></circle></svg></svg>'},
          (instance, button) => {
            button.onclick = () => {
              const coords = instance.apiManager?.coordsTilePixel;
              if (!coords?.[0]) {
                instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?');
                return;
              }
              instance.updateInnerHTML('bm-input-tx', coords?.[0] || '');
              instance.updateInnerHTML('bm-input-ty', coords?.[1] || '');
              instance.updateInnerHTML('bm-input-px', coords?.[2] || '');
              instance.updateInnerHTML('bm-input-py', coords?.[3] || '');
            }
          }
        ).buildElement()
        .addInput({'type': 'number', 'id': 'bm-input-tx', 'placeholder': 'Tl X', 'min': 0, 'max': 2047, 'step': 1, 'required': true}).buildElement()
        .addInput({'type': 'number', 'id': 'bm-input-ty', 'placeholder': 'Tl Y', 'min': 0, 'max': 2047, 'step': 1, 'required': true}).buildElement()
        .addInput({'type': 'number', 'id': 'bm-input-px', 'placeholder': 'Px X', 'min': 0, 'max': 2047, 'step': 1, 'required': true}).buildElement()
        .addInput({'type': 'number', 'id': 'bm-input-py', 'placeholder': 'Px Y', 'min': 0, 'max': 2047, 'step': 1, 'required': true}).buildElement()
      .buildElement()
      .addInputFile({'id': 'bm-input-file-template', 'textContent': 'Upload Template', 'accept': 'image/png, image/jpeg, image/webp, image/bmp, image/gif'}).buildElement()
      .addDiv({'id': 'bm-contain-buttons-template'})
        .addButton({'id': 'bm-button-enable', 'textContent': 'Enable'}, (instance, button) => {
          button.onclick = () => {
            instance.apiManager?.templateManager?.setTemplatesShouldBeDrawn(true);
            instance.handleDisplayStatus(`Enabled templates!`);
          }
        }).buildElement()
        .addButton({'id': 'bm-button-create', 'textContent': 'Create'}, (instance, button) => {
          button.onclick = () => {
            const input = document.querySelector('#bm-input-file-template');

            const coordTlX = document.querySelector('#bm-input-tx');
            if (!coordTlX.checkValidity()) {coordTlX.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return;}
            const coordTlY = document.querySelector('#bm-input-ty');
            if (!coordTlY.checkValidity()) {coordTlY.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return;}
            const coordPxX = document.querySelector('#bm-input-px');
            if (!coordPxX.checkValidity()) {coordPxX.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return;}
            const coordPxY = document.querySelector('#bm-input-py');
            if (!coordPxY.checkValidity()) {coordPxY.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return;}

            if (!input?.files[0]) {instance.handleDisplayError(`No file selected!`); return;}

            templateManager.createTemplate(input.files[0], input.files[0]?.name.replace(/\.[^/.]+$/, ''), [Number(coordTlX.value), Number(coordTlY.value), Number(coordPxX.value), Number(coordPxY.value)]);
            instance.handleDisplayStatus(`Drew to canvas!`);
          }
        }).buildElement()
        .addButton({'id': 'bm-button-disable', 'textContent': 'Disable'}, (instance, button) => {
          button.onclick = () => {
            instance.apiManager?.templateManager?.setTemplatesShouldBeDrawn(false);
            instance.handleDisplayStatus(`Disabled templates!`);
          }
        }).buildElement()
      .buildElement()
      .addTextarea({'id': overlayMain.outputStatusId, 'placeholder': `Status: Sleeping...\nVersion: ${version}`, 'readOnly': true}).buildElement()
      .addDiv({'id': 'bm-contain-buttons-action'})
        .addDiv()
          .addButton({'id': 'bm-button-convert', 'className': 'bm-help', 'innerHTML': '🎨', 'title': 'Template Color Converter'}, 
            (instance, button) => {
            button.addEventListener('click', () => {
              window.open('https://pepoafonso.github.io/color_converter_wplace/', '_blank', 'noopener noreferrer');
            });
          }).buildElement()
        .buildElement()
        .addSmall({'id': 'bm-pixel-queue-count', 'textContent': 'Queue: 0', 'style': 'margin-top: auto;'}).buildElement()
        .addSmall({'textContent': 'Made by SwingTheVine', 'style': 'margin-top: auto;'}).buildElement()
      .buildElement()
    .buildElement()
  .buildOverlay(document.body);
}

function buildOverlayTabTemplate() {
  overlayTabTemplate.addDiv({'id': 'bm-tab-template', 'style': 'top: 20%; left: 10%;'})
      .addDiv()
        .addDiv({'className': 'bm-dragbar'}).buildElement()
        .addButton({'className': 'bm-button-minimize', 'textContent': '↑'},
          (instance, button) => {
            button.onclick = () => {
              let isMinimized = false;
              if (button.textContent == '↑') {
                button.textContent = '↓';
              } else {
                button.textContent = '↑';
                isMinimized = true;
              }
            }
          }
        ).buildElement()
      .buildElement()
    .buildElement()
  .buildOverlay();
}
if (paintCountInput) {
    paintCountInput.addEventListener('input', (event) => {
        localStorage.setItem('bm-quick-paint-count', event.target.value);
    });
    // Initialize from localStorage
    paintCountInput.value = localStorage.getItem('bm-quick-paint-count') || '0';
}