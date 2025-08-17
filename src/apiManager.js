/** ApiManager class for handling API requests, responses, and interactions.
 * Note: Fetch spying is done in main.js, not here.
 * @class ApiManager
 * @since 0.11.1
 */

import TemplateManager from "./templateManager.js";
import { escapeHTML, numberToEncoded, serverTPtoDisplayTP } from "./utils.js";

export default class ApiManager {

  /** Constructor for ApiManager class
   * @param {TemplateManager} templateManager 
   * @since 0.11.34
   */
  constructor(templateManager) {
    this.templateManager = templateManager;
    this.disableAll = false; // Should the entire userscript be disabled?
    this.coordsTilePixel = []; // Contains the last detected tile/pixel coordinate pair requested
    this.templateCoordsTilePixel = []; // Contains the last "enabled" template coords
    this.currentCharges = 0;
  }

  /** Determines if the spontaneously recieved response is something we want.
   * Otherwise, we can ignore it.
   * Note: Due to aggressive compression, make your calls like `data['jsonData']['name']` instead of `data.jsonData.name`
   * 
   * @param {Overlay} overlay - The Overlay class instance
   * @since 0.11.1
  */
  spontaneousResponseListener(overlay) {

    // Triggers whenever a message is sent
    window.addEventListener('message', async (event) => {

      const data = event['data']; // The data of the message

      // Kills itself if the message was not intended for Blue Marble
      if (!(data && data['source'] === 'blue-marble')) {return;}

      // Listener for the quick paint trigger from the injected script
      if (data['action'] === 'executeQuickPaint' && data['token']) {
        this.executeQuickPaint(data['token'], overlay); // Pass overlay for UI updates
        return;
      }
      
      const dataJSON = data['jsonData']; // The JSON response, if any

      // Kills itself if the message has no endpoint (intended for Blue Marble, but not this function)
      if (!data['endpoint']) {return;}

      // Trims endpoint to the second to last non-number, non-null directoy.
      const endpointText = data['endpoint']?.split('?')[0].split('/').filter(s => s && isNaN(Number(s))).filter(s => s && !s.includes('.')).pop();

      console.log(`%cBlue Marble%c: Recieved message about "%s"`, 'color: cornflowerblue;', '', endpointText);

      switch (endpointText) {
        case 'me': // Request to retrieve user data
          if (dataJSON['status'] && dataJSON['status']?.toString()[0] != '2') {
            overlay.handleDisplayError(`You are not logged in!\nCould not fetch userdata.`);
            return;
          }

          const level = parseFloat(dataJSON['level']);
          const pixelsPainted = parseFloat(dataJSON['pixelsPainted']);
          const droplets = parseFloat(dataJSON['droplets']);
          if (dataJSON['charges'] && typeof dataJSON['charges']['count'] !== 'undefined') {
            this.currentCharges = Math.floor(dataJSON['charges']['count']);
          }

          this.templateManager.userID = dataJSON['id'];
          
          overlay.updateInnerHTML('bm-user-name', `Username: <b>${escapeHTML(dataJSON['name'])}</b>`);

          if (!isNaN(droplets)) {
            overlay.updateInnerHTML('bm-user-droplets', `Droplets: <b>${new Intl.NumberFormat().format(droplets)}</b>`);
          } else {
            overlay.updateInnerHTML('bm-user-droplets', `Droplets: <b>Unavailable</b>`);
          }

          if (!isNaN(level) && !isNaN(pixelsPainted)) {
            const nextLevelPixels = Math.ceil(Math.pow(Math.floor(level) * Math.pow(30, 0.65), (1 / 0.65)) - pixelsPainted);
            overlay.updateInnerHTML('bm-user-nextlevel', `Next level in <b>${new Intl.NumberFormat().format(nextLevelPixels)}</b> pixel${nextLevelPixels == 1 ? '' : 's'}`);
          } else {
            overlay.updateInnerHTML('bm-user-nextlevel', `Next level in... <b>Unavailable</b>`);
          }

          // --- NEW: Determine available colors from extraColorsBitmap ---
          const extraColorsBitmap = parseInt(dataJSON['extraColorsBitmap'], 10);
          const availableColors = {};
          const totalColors = 66; // Total number of colors in the palette
          const mediumGrayIndex = 32; // Index where extra colors start

          // Colors before Medium Gray (index 32) are always available.
          // Index 0 (Transparent) is also available for grief-cleaning.
          for (let i = 0; i < mediumGrayIndex; i++) {
              availableColors[i] = true;
          }

          if (!isNaN(extraColorsBitmap)) {
              // Convert the number to its 32-bit two's complement binary representation
              const binaryBitmap = (extraColorsBitmap >>> 0).toString(2).split('').reverse().join('');
              
              for (let i = 0; i < binaryBitmap.length; i++) {
                  const colorIndex = mediumGrayIndex + i;
                  if (colorIndex < totalColors) {
                      availableColors[colorIndex] = (binaryBitmap[i] === '1');
                  }
              }
              // Mark any remaining colors beyond the bitmap's length as unavailable.
              for (let i = mediumGrayIndex + binaryBitmap.length; i < totalColors; i++) {
                  availableColors[i] = false;
              }
          } else {
              // If bitmap is missing, assume all extra colors are unavailable.
              for (let i = mediumGrayIndex; i < totalColors; i++) {
                  availableColors[i] = false;
              }
          }
          localStorage.setItem('bm-available-colors', JSON.stringify(availableColors));
          break;

        case 'pixel': // Request to retrieve pixel data
          const coordsTile = data['endpoint'].split('?')[0].split('/').filter(s => s && !isNaN(Number(s)));
          const payloadExtractor = new URLSearchParams(data['endpoint'].split('?')[1]);
          const coordsPixel = [payloadExtractor.get('x'), payloadExtractor.get('y')];
          
          if (this.coordsTilePixel.length && (!coordsTile.length || !coordsPixel.length)) {
            overlay.handleDisplayError(`Coordinates are malformed!\nDid you try clicking the canvas first?`);
            return;
          }
          
          this.coordsTilePixel = [...coordsTile, ...coordsPixel];
          const displayTP = serverTPtoDisplayTP(coordsTile, coordsPixel);
          
          const spanElements = document.querySelectorAll('span');
          for (const element of spanElements) {
            if (element.textContent.trim().includes(`${displayTP[0]}, ${displayTP[1]}`)) {
              let displayCoords = document.querySelector('#bm-display-coords');
              const text = `(Tl X: ${coordsTile[0]}, Tl Y: ${coordsTile[1]}, Px X: ${coordsPixel[0]}, Px Y: ${coordsPixel[1]})`;
              
              if (!displayCoords) {
                displayCoords = document.createElement('span');
                displayCoords.id = 'bm-display-coords';
                displayCoords.textContent = text;
                displayCoords.style = 'margin-left: calc(var(--spacing)*3); font-size: small;';
                element.parentNode.parentNode.parentNode.insertAdjacentElement('afterend', displayCoords);
              } else {
                displayCoords.textContent = text;
              }
            }
          }
          break;
        
        case 'tiles':
          let tileCoordsTile = data['endpoint'].split('/');
          tileCoordsTile = [parseInt(tileCoordsTile[tileCoordsTile.length - 2]), parseInt(tileCoordsTile[tileCoordsTile.length - 1].replace('.png', ''))];
          const templateBlob = await this.templateManager.drawTemplateOnTile(data['blobData'], tileCoordsTile);
          window.postMessage({
            source: 'blue-marble',
            blobID: data['blobID'],
            blobData: templateBlob,
            blink: data['blink']
          });
          break;

        case 'robots':
          this.disableAll = dataJSON['userscript']?.toString().toLowerCase() == 'false';
          break;
      }
    });
  }

  /**
   * Groups pixels from the queue by tile and sends batched paint requests.
   * @param {string} token - The paint token intercepted from a valid user action.
   * @param {Overlay} overlay - The Overlay class instance for UI updates.
   * @since 0.82.0
   */
  async executeQuickPaint(token, overlay) {
    // --- MODIFIED: Analyze visible tiles to build the queue just-in-time ---
    await this.templateManager.analyzeVisibleTiles();

    const pixelQueue = this.templateManager.pixelQueue;

    if (!pixelQueue || pixelQueue.length === 0) {
      overlay.handleDisplayStatus('Quick Paint: Queue is empty or no pixels need painting.');
      return;
    }

    const paintCountInput = document.querySelector('#bm-input-paint-count');
    const reservedCharges = parseInt(paintCountInput?.value, 10) || 0;
    const paintCount = Math.max(0, this.currentCharges - reservedCharges);
    
    // --- MODIFIED: Filter queue based on available colors just-in-time ---
    const availableColors = JSON.parse(localStorage.getItem('bm-available-colors') || '{}');
    // Allow grief-clean (colorId 0) and any color marked as available.
    const filteredQueue = pixelQueue.filter(pixel => pixel.colorId === 0 || availableColors[pixel.colorId]);

    if (filteredQueue.length === 0) {
      overlay.handleDisplayStatus('Quick Paint: No pixels to paint with available colors.');
      return;
    }
    
    // Prioritize pixels with the largest perceptual color difference from the filtered queue.
    const sortedQueue = [...filteredQueue].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const pixelsToPaint = sortedQueue.slice(0, Math.min(paintCount, sortedQueue.length));

    if (pixelsToPaint.length === 0) return;

    overlay.handleDisplayStatus(`Quick Painting ${pixelsToPaint.length} high-priority pixel(s)...`);
    const tilesToPaint = new Map();

    try {
        for (const pixel of pixelsToPaint) {
            if (!pixel || !pixel['tileCoords'] || !pixel['pixelCoords']) {
                console.error('[Quick Paint] Found a malformed pixel in the queue:', pixel);
                continue;
            }
            const key = pixel['tileCoords'].join(',');
            if (!tilesToPaint.has(key)) {
                tilesToPaint.set(key, { colors: [], coords: [] });
            }
            const group = tilesToPaint.get(key);
            group.colors.push(pixel['colorId']);
            group.coords.push(...pixel['pixelCoords']);
        }
    } catch (error) {
        console.error('%cBlue Marble%c: [Quick Paint] An error occurred while grouping pixels.', 'color: cornflowerblue;', '', error);
        overlay.handleDisplayError('Quick Paint failed while grouping pixels.');
        return;
    }
    
    console.log(`%cBlue Marble%c: Grouped ${pixelsToPaint.length} high-priority pixel(s) into ${tilesToPaint.size} tile(s) for quick paint.`, 'color: cornflowerblue;', '');
    const paintPromises = [];

    for (const [key, group] of tilesToPaint.entries()) {
      const [tileX, tileY] = key.split(',');
      const url = `https://backend.wplace.live/s0/pixel/${tileX}/${tileY}`;

      // --- FIX: Use string literals for keys to prevent minification ---
      const payload = {
        'colors': group.colors,
        'coords': group.coords,
        't': token,
      };

      const requestPromise = fetch(url, {
        method: 'POST',
        headers: {
          'accept': '*/*',
          'content-type': 'text/plain;charset=UTF-8',
          'origin': 'https://wplace.live',
          'referer': 'https://wplace.live/',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-site',
        },
        body: JSON.stringify(payload),
        credentials: 'include',
      }).then(response => {
        if (!response.ok) {
          console.error(`Quick Paint failed for tile ${key}. Status: ${response.status}`);
        } else {
            console.log(`%cBlue Marble%c: Quick Paint successful for ${group.colors.length} pixels on tile ${key}.`, 'color: cornflowerblue;', '');
        }
      }).catch(error => {
        console.error(`Quick Paint network error for tile ${key}:`, error);
      });
      paintPromises.push(requestPromise);
    }

    await Promise.all(paintPromises);

    // Create a set of unique identifiers for the pixels that were painted.
    const paintedPixelKeys = new Set(
        pixelsToPaint.map(p => `${p.tileCoords.join(',')}-${p.pixelCoords.join(',')}`)
    );
    
    // Filter the original queue to remove the pixels that have been painted.
    this.templateManager.pixelQueue = this.templateManager.pixelQueue.filter(
        p => !paintedPixelKeys.has(`${p.tileCoords.join(',')}-${p.pixelCoords.join(',')}`)
    );
    
    this.templateManager.updatePixelQueueAttribute();
    this.templateManager.updatePixelQueueCountUI();

    overlay.handleDisplayStatus(`Quick Paint finished. ${this.templateManager.pixelQueue.length} pixels remaining.`);
  }
}