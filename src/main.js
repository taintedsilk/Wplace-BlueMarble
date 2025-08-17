/** @file The main file. Everything in the userscript is executed from here.
 * @since 0.0.0
 */

import Overlay from './Overlay.js';
import Observers from './observers.js';
import ApiManager from './apiManager.js';
import TemplateManager from './templateManager.js';
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

  // Overridden fetch function
  window.fetch = async function(...args) {
    const request = new Request(args[0], args[1]);
    
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

                return Promise.resolve(new Response(JSON.stringify({ success: true, message: "Quick Paint initiated." }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                }));
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
// Imports the CSS file from dist folder on github
const cssOverlay = GM_getResourceText("CSS-BM-File");
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
const templateManager = new TemplateManager(name, version, overlayMain); // Constructs a new TemplateManager object
const apiManager = new ApiManager(templateManager); // Constructs a new ApiManager object

overlayMain.setApiManager(apiManager); // Sets the API manager

const storageTemplates = JSON.parse(GM_getValue('bmTemplates', '{}'));
templateManager.importJSON(storageTemplates); // Loads the templates

buildOverlayMain(); // Builds the main overlay

const quickPaintCheckbox = document.querySelector('#bm-input-quick-paint');
const paintCountInput = document.querySelector('#bm-input-paint-count');

if (quickPaintCheckbox) {
    quickPaintCheckbox.addEventListener('change', (event) => {
        localStorage.setItem('bm-quick-paint-enabled', event.target.checked);
    });
    // Initialize from localStorage
    quickPaintCheckbox.checked = localStorage.getItem('bm-quick-paint-enabled') === 'true';
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