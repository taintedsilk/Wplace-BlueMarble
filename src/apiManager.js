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
   * @param {AutoPainter} autoPainter
   * @since 0.11.34
   */
  constructor(templateManager, autoPainter) {
    this.templateManager = templateManager;
    this.autoPainter = autoPainter; // Store the autoPainter instance
    this.disableAll = false; // Should the entire userscript be disabled?
    this.coordsTilePixel = []; // Contains the last detected tile/pixel coordinate pair requested
    this.templateCoordsTilePixel = []; // Contains the last "enabled" template coords
    this.currentCharges = 0;
    this.maxCharges = 0;
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
    window.addEventListener("message", async (event) => {
      const data = event["data"]; // The data of the message

      // Kills itself if the message was not intended for Blue Marble
      if (!(data && data["source"] === "blue-marble")) {
        return;
      }

      // Listener for the quick paint trigger from the injected script
      if (data["action"] === "executeQuickPaint" && data["token"]) {
        this.executeQuickPaint(data["token"], overlay); // Pass overlay for UI updates
        return;
      }

      const dataJSON = data["jsonData"]; // The JSON response, if any

      // Kills itself if the message has no endpoint (intended for Blue Marble, but not this function)
      if (!data["endpoint"]) {
        return;
      }

      // Trims endpoint to the second to last non-number, non-null directoy.
      const endpointText = data["endpoint"]
        ?.split("?")[0]
        .split("/")
        .filter((s) => s && isNaN(Number(s)))
        .filter((s) => s && !s.includes("."))
        .pop();

      console.log(
        `%cBlue Marble%c: Recieved message about "%s"`,
        "color: cornflowerblue;",
        "",
        endpointText
      );

      switch (endpointText) {
        case "me": // Request to retrieve user data
          if (dataJSON["status"] && dataJSON["status"]?.toString()[0] != "2") {
            overlay.handleDisplayError(
              `You are not logged in!\nCould not fetch userdata.`
            );
            return;
          }

          const level = parseFloat(dataJSON["level"]);
          const pixelsPainted = parseFloat(dataJSON["pixelsPainted"]);
          const droplets = parseFloat(dataJSON["droplets"]);
          if (
            dataJSON["charges"] &&
            typeof dataJSON["charges"]["count"] !== "undefined"
          ) {
            this.currentCharges = Math.floor(dataJSON["charges"]["count"]);
            this.maxCharges = Math.floor(dataJSON["charges"]["max"]);
            console.log(
              `%cBlue Marble%c: Current charges: ${this.currentCharges}, Max charges: ${this.maxCharges}`,
              "color: cornflowerblue;",
              ""
            );
          }

          this.templateManager.userID = dataJSON["id"];

          overlay.updateInnerHTML(
            "bm-user-name",
            `Username: <b>${escapeHTML(dataJSON["name"])}</b>`
          );

          if (!isNaN(droplets)) {
            overlay.updateInnerHTML(
              "bm-user-droplets",
              `Droplets: <b>${new Intl.NumberFormat().format(droplets)}</b>`
            );
          } else {
            overlay.updateInnerHTML(
              "bm-user-droplets",
              `Droplets: <b>Unavailable</b>`
            );
          }

          if (!isNaN(level) && !isNaN(pixelsPainted)) {
            const nextLevelPixels = Math.ceil(
              Math.pow(Math.floor(level) * Math.pow(30, 0.65), 1 / 0.65) -
                pixelsPainted
            );
            overlay.updateInnerHTML(
              "bm-user-nextlevel",
              `Next level in <b>${new Intl.NumberFormat().format(
                nextLevelPixels
              )}</b> pixel${nextLevelPixels == 1 ? "" : "s"}`
            );
          } else {
            overlay.updateInnerHTML(
              "bm-user-nextlevel",
              `Next level in... <b>Unavailable</b>`
            );
          }

          // --- NEW: Determine available colors from extraColorsBitmap ---
          const extraColorsBitmap = parseInt(dataJSON["extraColorsBitmap"], 10);
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
            const binaryBitmap = (extraColorsBitmap >>> 0)
              .toString(2)
              .split("")
              .reverse()
              .join("");

            for (let i = 0; i < binaryBitmap.length; i++) {
              const colorIndex = mediumGrayIndex + i;
              if (colorIndex < totalColors) {
                availableColors[colorIndex] = binaryBitmap[i] === "1";
              }
            }
            // Mark any remaining colors beyond the bitmap's length as unavailable.
            for (
              let i = mediumGrayIndex + binaryBitmap.length;
              i < totalColors;
              i++
            ) {
              availableColors[i] = false;
            }
          } else {
            // If bitmap is missing, assume all extra colors are unavailable.
            for (let i = mediumGrayIndex; i < totalColors; i++) {
              availableColors[i] = false;
            }
          }
          localStorage.setItem(
            "bm-available-colors",
            JSON.stringify(availableColors)
          );
          break;

        case "pixel": // Request to retrieve pixel data
          const coordsTile = data["endpoint"]
            .split("?")[0]
            .split("/")
            .filter((s) => s && !isNaN(Number(s)));
          const payloadExtractor = new URLSearchParams(
            data["endpoint"].split("?")[1]
          );
          const coordsPixel = [
            payloadExtractor.get("x"),
            payloadExtractor.get("y"),
          ];

          if (
            this.coordsTilePixel.length &&
            (!coordsTile.length || !coordsPixel.length)
          ) {
            overlay.handleDisplayError(
              `Coordinates are malformed!\nDid you try clicking the canvas first?`
            );
            return;
          }

          this.coordsTilePixel = [...coordsTile, ...coordsPixel];
          const displayTP = serverTPtoDisplayTP(coordsTile, coordsPixel);

          const spanElements = document.querySelectorAll("span");
          for (const element of spanElements) {
            if (
              element.textContent
                .trim()
                .includes(`${displayTP[0]}, ${displayTP[1]}`)
            ) {
              let displayCoords = document.querySelector("#bm-display-coords");
              const text = `(Tl X: ${coordsTile[0]}, Tl Y: ${coordsTile[1]}, Px X: ${coordsPixel[0]}, Px Y: ${coordsPixel[1]})`;

              if (!displayCoords) {
                displayCoords = document.createElement("span");
                displayCoords.id = "bm-display-coords";
                displayCoords.textContent = text;
                displayCoords.style =
                  "margin-left: calc(var(--spacing)*3); font-size: small;";
                element.parentNode.parentNode.parentNode.insertAdjacentElement(
                  "afterend",
                  displayCoords
                );
              } else {
                displayCoords.textContent = text;
              }
            }
          }
          break;

        case "tiles":
          let tileCoordsTile = data["endpoint"].split("/");
          tileCoordsTile = [
            parseInt(tileCoordsTile[tileCoordsTile.length - 2]),
            parseInt(
              tileCoordsTile[tileCoordsTile.length - 1].replace(".png", "")
            ),
          ];
          const templateBlob = await this.templateManager.drawTemplateOnTile(
            data["blobData"],
            tileCoordsTile
          );
          window.postMessage({
            source: "blue-marble",
            blobID: data["blobID"],
            blobData: templateBlob,
            blink: data["blink"],
          });
          break;

        case "robots":
          this.disableAll =
            dataJSON["userscript"]?.toString().toLowerCase() == "false";
          break;
      }
    });
  }

  /**
   * --- NEW ---
   * Fetches a tile directly from the server and analyzes it against template chunks.
   * @param {number} tileX - The x-coordinate of the tile.
   * @param {number} tileY - The y-coordinate of the tile.
   * @param {Array<Object>} templateChunks - The template parts that are on this tile.
   * @returns {Promise<Array<Object>>} A promise that resolves to an array of pixels to be painted.
   */
  async fetchAndAnalyzeTile(tileX, tileY, templateChunks) {
    const url = `https://backend.wplace.live/files/s0/tiles/${tileX}/${tileY}.png`;
    const response = await fetch(url, {
      headers: {
        accept: "image/webp,*/*",
        Referer: "https://wplace.live/",
        "sec-ch-ua":
          '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
      },
      credentials: "omit", // Do not send cookies with this request
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch tile ${tileX},${tileY}: ${response.statusText}`
      );
    }

    const tileBlob = await response.blob();

    // Prepare template data for analysis
    const templatesToDraw = templateChunks.map((chunk) => {
      const coords = chunk.chunkKey.split(",");
      return {
        bitmap: chunk.template.chunked[chunk.chunkKey],
        pixelCoords: [coords[2], coords[3]],
      };
    });

    // Call the analysis function from TemplateManager with the fetched data
    return this.templateManager.analyzeTile(tileBlob, templatesToDraw, [
      tileX,
      tileY,
    ]);
  }

  /**
   * --- MODIFIED ---
   * Executes the Quick Paint process by fetching live tile data, analyzing it, and painting.
   * @param {string} token - The paint token intercepted from a valid user action.
   * @param {Overlay} overlay - The Overlay class instance for UI updates.
   */
  async executeQuickPaint(token, overlay) {
    if (
      !this.templateManager.templatesArray ||
      this.templateManager.templatesArray.length === 0
    ) {
      overlay.handleDisplayStatus("Quick Paint: No templates loaded.");
      this.autoPainter?.onQuickPaintFinished();
      return;
    }

    // --- Step 1: Group all template pixels by their respective tiles ---
    const allTemplatePixelsByTile = new Map();
    for (const template of this.templateManager.templatesArray) {
      for (const chunkKey in template.chunked) {
        const parts = chunkKey.split(",");
        const tileCoordsKey = `${parseInt(parts[0], 10)},${parseInt(
          parts[1],
          10
        )}`;
        if (!allTemplatePixelsByTile.has(tileCoordsKey)) {
          allTemplatePixelsByTile.set(tileCoordsKey, []);
        }
        allTemplatePixelsByTile.get(tileCoordsKey).push({ template, chunkKey });
      }
    }

    if (allTemplatePixelsByTile.size === 0) {
      overlay.handleDisplayStatus("Quick Paint: Template has no pixels.");
      this.autoPainter?.onQuickPaintFinished();
      return;
    }

    overlay.handleDisplayStatus(
      `Analyzing ${allTemplatePixelsByTile.size} template tile(s)...`
    );

    // --- Step 2: Concurrently fetch and analyze all required tiles ---
    const analysisPromises = [];
    for (const [
      tileCoordsKey,
      templateChunks,
    ] of allTemplatePixelsByTile.entries()) {
      const [tileX, tileY] = tileCoordsKey.split(",").map(Number);
      const promise = this.fetchAndAnalyzeTile(
        tileX,
        tileY,
        templateChunks
      ).catch((err) => {
        console.error(
          `[Quick Paint] Failed to analyze tile ${tileCoordsKey}:`,
          err
        );
        return []; // Return an empty array on failure to not break Promise.all
      });
      analysisPromises.push(promise);
    }

    // --- Step 3: Consolidate results into a single queue ---
    const analysisResults = await Promise.all(analysisPromises);
    const fullPixelQueue = analysisResults.flat();

    // Update TemplateManager's queue for UI purposes
    this.templateManager.pixelQueue = fullPixelQueue;
    this.templateManager.updatePixelQueueAttribute();
    this.templateManager.updatePixelQueueCountUI();

    // Diagnostic log
    console.log(
      "%cBlue Marble%c: [Quick Paint] Analysis results:",
      "color: cornflowerblue;",
      "",
      {
        fullPixelQueueLength: fullPixelQueue.length,
        currentCharges: this.currentCharges,
        maxCharges: this.maxCharges,
      }
    );

    // Helper: burn function extracted to reuse in multiple places
    const burnTenCharges = async (tileX, tileY) => {
      const url = `https://backend.wplace.live/s0/pixel/${tileX}/${tileY}`;
      const randomCoords = [];
      const colors = [];
      for (let i = 0; i < 10; i++) {
        const px = Math.floor(Math.random() * 1000);
        const py = Math.floor(Math.random() * 1000);
        randomCoords.push(px, py);
        colors.push(0); // transparent
      }
      
      // --- FIX: Use string literals for payload keys to prevent obfuscation ---
      const payload = { 'colors': colors, 'coords': randomCoords, 't': token };

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: JSON.stringify(payload),
          credentials: "include",
        });
        if (response.ok) {
          console.log(
            `[Quick Paint] Burned 10 charges with transparent pixels at ${tileX},${tileY}`
          );
          overlay.handleDisplayStatus(
            `Quick Paint: Burned 10 charges at ${tileX},${tileY}.`
          );
        } else {
          console.warn(
            `[Quick Paint] Failed to burn charges. Status ${response.status}`
          );
          overlay.handleDisplayStatus(
            `Quick Paint: Failed to burn charges (status ${response.status}).`
          );
        }
      } catch (err) {
        console.error(
          `[Quick Paint] Network error while burning charges:`,
          err
        );
        overlay.handleDisplayError(
          "Quick Paint: Network error while burning charges."
        );
      }
    };

    // If analysis returned nothing at all -> original burn location
    if (fullPixelQueue.length === 0) {
      // If fully charged, waste 10 charges by painting transparent pixels
      if (this.currentCharges >= this.maxCharges && this.maxCharges > 0) {
        overlay.handleDisplayStatus(
          "Quick Paint: No template work. Burning 10 charges with random transparent pixels..."
        );

        // Pick a random loaded template tile (or current coords if known)
        let tileX = 0,
          tileY = 0;
        if (this.coordsTilePixel.length >= 2) {
          tileX = parseInt(this.coordsTilePixel[0]);
          tileY = parseInt(this.coordsTilePixel[1]);
        } else {
          // fallback: pick the first template tile
          const firstKey = [...allTemplatePixelsByTile.keys()][0];
          if (firstKey) {
            [tileX, tileY] = firstKey.split(",").map(Number);
          } else {
            // ultimate fallback: choose tile 0,0
            tileX = 0;
            tileY = 0;
          }
        }

        await burnTenCharges(tileX, tileY);
      } else {
        overlay.handleDisplayStatus(
          "Quick Paint: Queue is empty, canvas is up to date."
        );
      }

      this.autoPainter?.onQuickPaintFinished();
      return;
    }

    // --- Step 4: Filter, sort, and select pixels to paint ---
    const paintCountInput = document.querySelector("#bm-input-paint-count");
    const reservedCharges = parseInt(paintCountInput?.value, 10) || 0;
    const paintCount = Math.max(0, this.currentCharges - reservedCharges);

    const availableColors = JSON.parse(
      localStorage.getItem("bm-available-colors") || "{}"
    );
    const filteredQueue = fullPixelQueue.filter(
      (pixel) => pixel.colorId === 0 || availableColors[pixel.colorId]
    );

    // Diagnostic log after filtering
    console.log(
      "%cBlue Marble%c: [Quick Paint] Post-filter info:",
      "color: cornflowerblue;",
      "",
      {
        filteredQueueLength: filteredQueue.length,
        paintCount,
        reservedCharges,
        currentCharges: this.currentCharges,
        maxCharges: this.maxCharges,
      }
    );

    // NEW: If there are template candidates but none are paintable with available colors OR paintCount is zero,
    // consider burning charges if we're fully charged.
    if (filteredQueue.length === 0 || paintCount === 0) {
      // If fully charged, burn charges (so we don't saturate)
      if (this.currentCharges >= this.maxCharges && this.maxCharges > 0) {
        overlay.handleDisplayStatus(
          "Quick Paint: No pixels to paint with available colors or no available paint count. Burning 10 charges with random transparent pixels..."
        );

        // Choose tile for burning in a robust way:
        let tileX = 0,
          tileY = 0;
        if (this.coordsTilePixel.length >= 2) {
          tileX = parseInt(this.coordsTilePixel[0]);
          tileY = parseInt(this.coordsTilePixel[1]);
        } else {
          const firstKey = [...allTemplatePixelsByTile.keys()][0];
          if (firstKey) {
            [tileX, tileY] = firstKey.split(",").map(Number);
          } else {
            // If no template tile found, pick a random tile in range to avoid invalid coordinates
            tileX = Math.floor(Math.random() * 4); // small random fallback
            tileY = Math.floor(Math.random() * 4);
          }
        }

        await burnTenCharges(tileX, tileY);
        this.autoPainter?.onQuickPaintFinished();
        return;
      } else {
        overlay.handleDisplayStatus(
          "Quick Paint: No pixels to paint with available colors."
        );
        this.autoPainter?.onQuickPaintFinished();
        return;
      }
    }

    // MODIFIED: Use weighted random selection instead of just taking the top N
    const sortedQueue = [...filteredQueue].sort(
      (a, b) => (b.priority || 0) - (a.priority || 0)
    );
    
    const numToPaint = Math.min(paintCount, sortedQueue.length);
    let pixelsToPaint = [];

    if (numToPaint > 0) {
        // Use weighted random sampling without replacement (Algorithm A-ES by Efraimidis and Spirakis)
        // to give better-ranked pixels a higher chance of being selected.
        const L = sortedQueue.length;
        const weightedItems = sortedQueue.map((pixel, i) => {
            // Linearly decreasing weight from 3x for the best pixel (i=0) to 1x for the worst (i=L-1).
            const weight = L > 1 ? (-2.0 / (L - 1.0)) * i + 3.0 : 1.0;
            const u = Math.random(); // Random number in [0, 1)
            const key = Math.pow(u, 1.0 / weight);
            return { pixel, key };
        });

        // Sort by the generated key in descending order to get a random weighted order.
        weightedItems.sort((a, b) => b.key - a.key);

        // Take the top 'numToPaint' items from this newly sorted list.
        pixelsToPaint = weightedItems.slice(0, numToPaint).map(item => item.pixel);
    }


    if (pixelsToPaint.length === 0) {
      // As a last check: if we expected to paint but none selected because paintCount was 0, we've handled above.
      this.autoPainter?.onQuickPaintFinished();
      return;
    }

    overlay.handleDisplayStatus(
      `Quick Painting ${pixelsToPaint.length} high-priority pixel(s)...`
    );

    // --- Step 5: Group pixels by tile and send paint requests (existing logic) ---
    const tilesToPaint = new Map();
    for (const pixel of pixelsToPaint) {
      const key = pixel.tileCoords.join(",");
      if (!tilesToPaint.has(key)) {
        tilesToPaint.set(key, { colors: [], coords: [] });
      }
      const group = tilesToPaint.get(key);
      group.colors.push(pixel.colorId);
      group.coords.push(...pixel.pixelCoords);
    }

    console.log(
      `%cBlue Marble%c: Grouped ${pixelsToPaint.length} pixel(s) into ${tilesToPaint.size} tile(s) for quick paint.`,
      "color: cornflowerblue;",
      ""
    );

    const paintPromises = [];
    for (const [key, group] of tilesToPaint.entries()) {
      const [tileX, tileY] = key.split(",");
      const url = `https://backend.wplace.live/s0/pixel/${tileX}/${tileY}`;
      
      // --- FIX: Use string literals for payload keys to prevent obfuscation ---
      const payload = { 'colors': group.colors, 'coords': group.coords, 't': token };

      const requestPromise = fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(payload),
        credentials: "include",
      })
        .then((response) => {
          if (!response.ok)
            console.error(
              `Quick Paint failed for tile ${key}. Status: ${response.status}`
            );
          else
            console.log(
              `%cBlue Marble%c: Quick Paint successful for ${group.colors.length} pixels on tile ${key}.`,
              "color: cornflowerblue;",
              ""
            );
        })
        .catch((error) =>
          console.error(`Quick Paint network error for tile ${key}:`, error)
        );

      paintPromises.push(requestPromise);
    }

    await Promise.all(paintPromises);

    // --- Step 6: Update the queue and UI after painting ---
    const paintedPixelKeys = new Set(
      pixelsToPaint.map(
        (p) => `${p.tileCoords.join(",")}-${p.pixelCoords.join(",")}`
      )
    );
    this.templateManager.pixelQueue = this.templateManager.pixelQueue.filter(
      (p) =>
        !paintedPixelKeys.has(
          `${p.tileCoords.join(",")}-${p.pixelCoords.join(",")}`
        )
    );

    this.templateManager.updatePixelQueueAttribute();
    this.templateManager.updatePixelQueueCountUI();

    overlay.handleDisplayStatus(
      `Quick Paint finished. ${this.templateManager.pixelQueue.length} pixels remaining.`
    );

    this.autoPainter?.onQuickPaintFinished();
  }
}