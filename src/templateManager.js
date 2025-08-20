import Template from "./Template";
import { base64ToUint8, numberToEncoded, findClosestColor, calculateColorDifference, colorpalette } from "./utils";

/** Manages the template system.
 * This class handles all external requests for template modification, creation, and analysis.
 * It serves as the central coordinator between template instances and the user interface.
 * @class TemplateManager
 * @since 0.55.8
 */
export default class TemplateManager {

  /** The constructor for the {@link TemplateManager} class.
   * @param {string} name
   * @param {string} version
   * @param {Overlay} overlay
   * @param {AutoPainter} autoPainter
   * @since 0.55.8
   */
  constructor(name, version, overlay, autoPainter) {

    // Meta
    this.name = name; // Name of userscript
    this.version = version; // Version of userscript
    this.overlay = overlay; // The main instance of the Overlay class
    this.autoPainter = autoPainter; // Store the autoPainter instance
    this.templatesVersion = '1.0.0'; // Version of JSON schema
    this.userID = null; // The ID of the current user
    this.encodingBase = '!#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~'; // Characters to use for encoding/decoding
    this.tileSize = 1000; // The number of pixels in a tile. Assumes the tile is square
    this.drawMult = 3; // The enlarged size for each pixel. E.g. when "3", a 1x1 pixel becomes a 1x1 pixel inside a 3x3 area. MUST BE ODD
    
    // Template
    this.templatesArray = []; // All Template instnaces currently loaded (Template)
    this.templatesJSON = null; // All templates currently loaded (JSON)
    this.templatesShouldBeDrawn = true; // Should ALL templates be drawn to the canvas?
    this.analyzeTransparentPixels = false; // Should transparent pixels be targeted for analysis?
    this.pixelQueue = JSON.parse(localStorage.getItem('bm-pixel-queue') || '[]'); // The queue of pixels to be painted
    this.tileCache = new Map(); // Cache for tile data ArrayBuffers to detect changes and for on-demand analysis
    this.templateColorCache = new Map(); // Cache for mapping template colors to the game palette to reduce calculations.

  }

  /** Creates the JSON object to store templates in
   * @returns {{ whoami: string, scriptVersion: string, schemaVersion: string, templates: Object }} The JSON object
   * @since 0.65.4
   */
  async createJSON() {
    return {
      "whoami": this.name.replace(' ', ''), // Name of userscript without spaces
      "scriptVersion": this.version, // Version of userscript
      "schemaVersion": this.templatesVersion, // Version of JSON schema
      "templates": {} // The templates
    };
  }

  /** Creates the template from the inputed file blob
   * @param {File} blob - The file blob to create a template from
   * @param {string} name - The display name of the template
   * @param {Array<number, number, number, number>} coords - The coordinates of the top left corner of the template
   * @since 0.65.77
   */
  async createTemplate(blob, name, coords) {
    if (!this.templatesJSON) {
        this.templatesJSON = await this.createJSON();
    }

    this.overlay.handleDisplayStatus(`Creating template at ${coords.join(', ')}...`);

    const template = new Template({
      displayName: name,
      sortID: 0,
      authorID: numberToEncoded(this.userID || 0, this.encodingBase),
      file: blob,
      coords: coords
    });
    
    // --- FIX: Reverted this call to its original form to resolve the bug ---
    const { templateTiles, templateTilesBuffers } = await template.createTemplateTiles(this.tileSize);
    template.chunked = templateTiles;

    this.templatesJSON['templates'][`${template.sortID} ${template.authorID}`] = {
      "name": template.displayName,
      "coords": coords.join(', '),
      "enabled": true,
      "tiles": templateTilesBuffers
    };

    this.templatesArray = [template]; // Replace existing templates

    const pixelCountFormatted = new Intl.NumberFormat().format(template.pixelCount);
    this.overlay.handleDisplayStatus(`Template created at ${coords.join(', ')}! Total pixels: ${pixelCountFormatted}`);
    
    // Check if AutoPaint checkbox is enabled and start if it is.
    // This is no longer auto-started here by default; it depends on UI state.
    const autoPaintCheckbox = document.querySelector('#bm-input-autopaint');
    if (autoPaintCheckbox && autoPaintCheckbox.checked) {
        this.autoPainter?.start();
    }

    await this.#storeTemplates();
  }

  /** Stores the JSON object of the loaded templates into TamperMonkey (GreaseMonkey) storage.
   * @since 0.72.7
   */
  async #storeTemplates() {
    GM.setValue('bmTemplates', JSON.stringify(this.templatesJSON));
  }
  
  /** Imports the JSON object, and appends it to any JSON object already loaded
   * @param {string} json - The JSON string to parse
   */
  importJSON(json) {
    if (json && json['whoami'] === 'BlueMarble') {
      this.templatesJSON = json; // FIX: Assign the loaded JSON to the state variable
      this.#parseBlueMarble(json);
    }
  }

  /** Parses the Blue Marble JSON object
   * @param {string} json - The JSON string to parse
   * @since 0.72.13
   */
  async #parseBlueMarble(json) {
    const templates = json['templates'];
    if (Object.keys(templates).length > 0) {
      for (const templateKey in templates) {
        if (templates.hasOwnProperty(templateKey)) {
          const templateValue = templates[templateKey];
          const templateKeyArray = templateKey.split(' ');
          const sortID = Number(templateKeyArray[0]);
          const authorID = templateKeyArray[1] || '0';
          const displayName = templateValue['name'] || `Template ${sortID || ''}`;
          const tilesbase64 = templateValue['tiles'];
          const templateTiles = {};

          for (const tile in tilesbase64) {
            if (tilesbase64.hasOwnProperty(tile)) {
              const encodedTemplateBase64 = tilesbase64[tile];
              const templateUint8Array = base64ToUint8(encodedTemplateBase64);
              const templateBlob = new Blob([templateUint8Array], { type: "image/png" });
              templateTiles[tile] = await createImageBitmap(templateBlob);
            }
          }

          const template = new Template({
            displayName: displayName,
            sortID: sortID || this.templatesArray.length || 0,
            authorID: authorID || '',
          });
          template.chunked = templateTiles;
          this.templatesArray.push(template);
        }
      }
      
      // If AutoPaint checkbox is enabled on reload, and templates are now loaded, start it.
      // This is no longer auto-started here by default; it depends on UI state.
      const autoPaintCheckbox = document.querySelector('#bm-input-autopaint');
      if (autoPaintCheckbox && autoPaintCheckbox.checked) {
          this.autoPainter?.start();
      }
    }
  }

  /**
   * Sets the state for analyzing transparent pixels.
   * @param {boolean} value - True to enable targeting of transparent pixels, false otherwise.
   * @since 0.83.0
   */
  setAnalyzeTransparentPixels(value) {
    this.analyzeTransparentPixels = value;
    this.overlay.handleDisplayStatus(`Grief-Clean mode ${value ? 'enabled' : 'disabled'}.`);
  }

  /**
   * --- REMOVED ---
   * The analyzeVisibleTiles function has been removed. The logic for building the pixel queue
   * is now handled just-in-time by ApiManager.executeQuickPaint, which fetches live tile data.
   */

  /**
   * Analyzes a single tile and returns an array of pixels that need to be painted.
   * @param {Blob} tileBlob - The original tile image blob from the game server.
   * @param {Array<Object>} templatesToDraw - An array of template objects to be drawn on this tile.
   * @param {Array<number>} tileCoords - The coordinates of the tile being analyzed, as [x, y].
   * @returns {Promise<Array<Object>>} A promise that resolves to an array of pixel data objects for the queue.
   * @since MODIFIED
   */
  async analyzeTile(tileBlob, templatesToDraw, tileCoords) {
    if (templatesToDraw.length === 0) return [];

    const drawSize = this.tileSize * this.drawMult;
    
    let minX = this.tileSize, minY = this.tileSize, maxX = 0, maxY = 0;

    for (const template of templatesToDraw) {
      const startX = Number(template['pixelCoords'][0]);
      const startY = Number(template['pixelCoords'][1]);
      const templateWidth = template['bitmap'].width / this.drawMult;
      const templateHeight = template['bitmap'].height / this.drawMult;

      minX = Math.min(minX, startX);
      minY = Math.min(minY, startY);
      maxX = Math.max(maxX, startX + templateWidth);
      maxY = Math.max(maxY, startY + templateHeight);
    }

    const gameCanvas = new OffscreenCanvas(drawSize, drawSize);
    const gameCtx = gameCanvas.getContext('2d');
    const gameBitmap = await createImageBitmap(tileBlob);
    gameCtx.drawImage(gameBitmap, 0, 0, drawSize, drawSize);
    const gameImageData = gameCtx.getImageData(0, 0, drawSize, drawSize).data;

    const templateCanvas = new OffscreenCanvas(drawSize, drawSize);
    const templateCtx = templateCanvas.getContext('2d');
    for (const template of templatesToDraw) {
      templateCtx.drawImage(template['bitmap'], Number(template['pixelCoords'][0]) * this.drawMult, Number(template['pixelCoords'][1]) * this.drawMult);
    }
    const templateImageData = templateCtx.getImageData(0, 0, drawSize, drawSize).data;
    
    const newPixelsForQueue = [];
    
    const centerX = minX + (maxX - minX) / 2;
    const centerY = minY + (maxY - minY) / 2;
    const maxDist = Math.sqrt(Math.pow(maxX - centerX, 2) + Math.pow(maxY - centerY, 2));

    for (let y = minY; y < maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        const index = ((y * this.drawMult + 1) * drawSize + (x * this.drawMult + 1)) * 4;

        const templateR = templateImageData[index], templateG = templateImageData[index + 1], templateB = templateImageData[index + 2], templateAlpha = templateImageData[index + 3];
        const gameR = gameImageData[index], gameG = gameImageData[index + 1], gameB = gameImageData[index + 2], gameAlpha = gameImageData[index + 3];

        let pixelData = null;

        // Tier 1: Grief-Clean. Template is transparent, canvas has color.
        if (this.analyzeTransparentPixels && templateAlpha < 128 && gameAlpha > 0) {
            pixelData = {
                'tileCoords': tileCoords,
                'pixelCoords': [x, y],
                'colorId': 0, // Paint "transparent" to erase
                'priority': 2000000 // Highest priority
            };
        } 
        // Tier 2 & 3: Standard Paint. Template has a color.
        else if (templateAlpha > 128) {
            const isTransparent = gameAlpha < 128;
            
            // --- OPTIMIZATION: Use a cache and a fast RGB check for converting template colors ---
            const templateColorKey = (templateAlpha << 24) | (templateB << 16) | (templateG << 8) | templateR;
            let targetColorId;

            if (this.templateColorCache.has(templateColorKey)) {
                targetColorId = this.templateColorCache.get(templateColorKey);
            } else {
                targetColorId = findClosestColor({ r: templateR, g: templateG, b: templateB });
                this.templateColorCache.set(templateColorKey, targetColorId);
            }
            
            let isWrongColor = false;

            if (!isTransparent) {
                // --- OPTIMIZATION: Use the fast RGB check for canvas colors as well ---
                const currentColorId = findClosestColor({ r: gameR, g: gameG, b: gameB });
                if (currentColorId !== targetColorId) {
                    isWrongColor = true;
                }
            }

            if (isTransparent || isWrongColor) {
                const colorId = targetColorId;
                
                const distFromCenter = Math.sqrt(Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2));
                const normalizedDist = maxDist > 0 ? distFromCenter / maxDist : 0;
                const centerBonus = (1 - normalizedDist) * 500000;

                pixelData = {
                    'tileCoords': tileCoords,
                    'pixelCoords': [x, y],
                    'colorId': colorId,
                    'priority': 0
                };

                // Tier 2: Placing a pixel on a transparent spot.
                if (isTransparent) {
                    pixelData.priority = 1000000 + centerBonus;
                } 
                // Tier 3: Correcting an existing, but wrong, color.
                else {
                    const MAX_PRIORITY_SCORE = 500000; // Max score for color difference to balance with centerBonus
                    const colorDifference = calculateColorDifference({ r: gameR, g: gameG, b: gameB }, { r: templateR, g: templateG, b: templateB });
                    // Normalize deltaE to a 0-1 scale (clamping at 100, which is a very large difference) and then scale to our priority range.
                    const colorPriority = Math.min(colorDifference / 100.0, 1.0) * MAX_PRIORITY_SCORE;
                    pixelData.priority = colorPriority + centerBonus;
                }
            }
        }

        if (pixelData) {
            const toColorName = colorpalette[pixelData.colorId]?.name || 'Unknown';
            let logMessage = '';

            // Case 1: Grief-Clean
            if (pixelData.colorId === 0) {
                const fromColorId = findClosestColor({ r: gameR, g: gameG, b: gameB });
                const fromColorName = colorpalette[fromColorId]?.name || `RGB(${gameR},${gameG},${gameB})`;
                // logMessage = `Queueing [Grief-Clean] at [${x}, ${y}] on tile [${tileCoords.join(',')}]. Removing '${fromColorName}' (Priority: ${pixelData.priority.toFixed(0)}).`;
            }
            // Case 2 & 3: Standard Paint
            else {
                const isTransparent = gameAlpha < 128;
                if (isTransparent) { // Painting on empty spot
                    // logMessage = `Queueing [New Pixel] at [${x}, ${y}] on tile [${tileCoords.join(',')}]. Painting '${toColorName}' over transparent (Priority: ${pixelData.priority.toFixed(0)}).`;
                } else { // Correcting wrong color
                    const fromColorId = findClosestColor({ r: gameR, g: gameG, b: gameB });
                    const fromColorName = colorpalette[fromColorId]?.name || `RGB(${gameR},${gameG},${gameB})`;
                    // logMessage = `Queueing [Correction] at [${x}, ${y}] on tile [${tileCoords.join(',')}]. Changing '${fromColorName}' to '${toColorName}' (Priority: ${pixelData.priority.toFixed(0)}).`;
                }
            }
            
            if (logMessage) {
                console.log(`%cBlue Marble%c: ${logMessage}`, 'color: cornflowerblue;', '');
            }
            newPixelsForQueue.push(pixelData);
        }
      }
    }
    
    return newPixelsForQueue;
  }

  /**
   * Saves the current pixel queue to localStorage for the injected script to access.
   * @since 0.83.0
   */
  updatePixelQueueAttribute() {
    localStorage.setItem('bm-pixel-queue', JSON.stringify(this.pixelQueue));
  }

  /**
   * Updates the UI element to show the current number of pixels in the queue.
   * @since 0.83.0
   */
  updatePixelQueueCountUI() {
    const queueCountElement = document.querySelector('#bm-pixel-queue-count');
    if (queueCountElement) {
        queueCountElement.textContent = `Queue: ${this.pixelQueue.length}`;
    }
  }

   /**
   * Draws all templates on the specified tile, showing the overlay only on incorrect or empty pixels.
   * This function provides the visual feedback to the user.
   * @param {Blob} tileBlob - The original tile image blob from the game server.
   * @param {Array<number>} tileCoords - The tile coordinates [x, y].
   * @returns {Promise<Blob>} A promise resolving to the modified tile Blob with the selective overlay.
   * @since MODIFIED
   */
  async drawTemplateOnTile(tileBlob, tileCoords) {
    // Cache the latest version of the tile for on-demand analysis by other functions.
    const tileKey = tileCoords.join(',');
    this.tileCache.set(tileKey, await tileBlob.arrayBuffer());

    // If templates are disabled, return the original tile immediately.
    if (!this.templatesShouldBeDrawn) {
        return tileBlob;
    }
    
    // Find all template chunks that are located on the current tile.
    const formattedTileCoords = tileCoords[0].toString().padStart(4, '0') + ',' + tileCoords[1].toString().padStart(4, '0');
    const templatesToDraw = this.templatesArray
      .flatMap(template => 
        Object.keys(template.chunked)
          .filter(tileKey => tileKey.startsWith(formattedTileCoords))
          .map(tileKey => {
            const coords = tileKey.split(',');
            return {
              'bitmap': template.chunked[tileKey],
              'pixelCoords': [coords[2], coords[3]],
              'sortID': template.sortID // Keep sortID for correct layering
            };
          })
      )
      .sort((a, b) => (a.sortID || 0) - (b.sortID || 0));

    // If no templates are on this tile, return the original.
    if (templatesToDraw.length === 0) {
      return tileBlob;
    }

    // Update the UI status with template information.
    this.overlay.handleDisplayStatus(
      `Displaying ${templatesToDraw.length} template${templatesToDraw.length === 1 ? '' : 's'}.`
    );

    const drawSize = this.tileSize * this.drawMult;
    const tileBitmap = await createImageBitmap(tileBlob);

    // This is the main canvas we will work on and eventually return.
    const finalCanvas = new OffscreenCanvas(drawSize, drawSize);
    const finalCtx = finalCanvas.getContext('2d', { willReadFrequently: true });
    finalCtx.imageSmoothingEnabled = false;

    // Step 1: Draw the original game tile as the base layer.
    finalCtx.drawImage(tileBitmap, 0, 0, drawSize, drawSize);

    // Step 2: Get the pixel data of the game tile to compare against.
    const gameImageData = finalCtx.getImageData(0, 0, drawSize, drawSize);
    const gameData = gameImageData.data;

    // Step 3: For each template, create a filtered version containing only the necessary pixels and draw it.
    for (const template of templatesToDraw) {
      const tempW = template.bitmap.width;
      const tempH = template.bitmap.height;
      const offsetX = Number(template.pixelCoords[0]) * this.drawMult;
      const offsetY = Number(template.pixelCoords[1]) * this.drawMult;

      // Get the template's pixel data.
      const tempCanvas = new OffscreenCanvas(tempW, tempH);
      const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
      tempCtx.drawImage(template.bitmap, 0, 0);
      const templateImgData = tempCtx.getImageData(0, 0, tempW, tempH);
      const tData = templateImgData.data;

      // Iterate through each pixel of the template chunk.
      for (let y = 0; y < tempH; y++) {
        for (let x = 0; x < tempW; x++) {
          const tIdx = (y * tempW + x) * 4;
          const tAlpha = tData[tIdx + 3];

          // We only care about visible pixels in the template overlay.
          if (tAlpha > 128) {
            const gX = x + offsetX;
            const gY = y + offsetY;
            
            // Ensure we are within the bounds of the tile.
            if (gX < drawSize && gY < drawSize) {
              const gIdx = (gY * drawSize + gX) * 4;

              const tR = tData[tIdx];
              const tG = tData[tIdx + 1];
              const tB = tData[tIdx + 2];

              const gR = gameData[gIdx];
              const gG = gameData[gIdx + 1];
              const gB = gameData[gIdx + 2];
              const gAlpha = gameData[gIdx + 3];

              // If the game pixel is visible and its color already matches the template,
              // make the corresponding template pixel transparent so it doesn't get drawn.
              // This is now a simple and fast RGB check because the template is pre-palletized.
              if (gAlpha > 128 && tR === gR && tG === gG && tB === gB) {
                tData[tIdx + 3] = 0;
              }
            }
          }
        }
      }

      // Step 4: Apply the changes and draw the filtered template onto the final canvas.
      tempCtx.putImageData(templateImgData, 0, 0);
      finalCtx.drawImage(tempCanvas, offsetX, offsetY);
    }
    
    // Step 5: Convert the final canvas to a blob and return it.
    return await finalCanvas.convertToBlob({ type: 'image/png' });
  }
}