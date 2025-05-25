/**
 * Tile Tracker Google Apps Script v2.1
 *
 * Fetches location history for a specified Tile device using Tile APIs
 * based on inspection of the pytile library (v2022.11.0 or similar).
 * Implements required headers, 2-step login, and cookie handling.
 * Caches data in a Google Sheet.
 * v2.1: Corrected processing logic for history response structure.
 *
 * @OnlyCurrentDoc Limits the script to only accessing the Spreadsheet it's bound to.
 */

// --- Configuration ---
// USE SCRIPT PROPERTIES (Recommended for credentials & configuration)
// Go to File -> Project properties -> Script properties in the Apps Script editor.
// Add properties for: TILE_EMAIL, TILE_PASSWORD, TILE_NAME, SPREADSHEET_ID, SHEET_NAME
// Optional: Add CLIENT_UUID if you want to reuse a specific one, otherwise one will be generated/stored.
var SCRIPT_PROPS = PropertiesService.getScriptProperties();
var TILE_EMAIL = SCRIPT_PROPS.getProperty('TILE_EMAIL');
var TILE_PASSWORD = SCRIPT_PROPS.getProperty('TILE_PASSWORD');
var TILE_NAME = SCRIPT_PROPS.getProperty('TILE_NAME');
var SPREADSHEET_ID = SCRIPT_PROPS.getProperty('SPREADSHEET_ID'); // The ID of the Google Sheet
var SHEET_NAME = SCRIPT_PROPS.getProperty('SHEET_NAME'); // Name of the sheet tab for caching

// --- Constants based on pytile api.py/const.py ---
var BASE_API_URL = "https://production.tile-api.com/api/v1";
var TILE_API_VERSION = "1.0"; // From DEFAULT_API_VERSION
var TILE_APP_ID = "ios-tile-production"; // From DEFAULT_APP_ID
var TILE_APP_VERSION = "2.89.1.4774"; // From DEFAULT_APP_VERSION
var TILE_LOCALE = "en-US"; // From DEFAULT_LOCALE
var TILE_USER_AGENT = "Tile/4774 CFNetwork/1312 Darwin/21.0.0"; // From DEFAULT_USER_AGENT

// --- Helper Function to Manage Client UUID ---
/**
 * Gets the client UUID, generating and storing one if necessary.
 * @return {string} The client UUID.
 */
function getClientUuid() {
  var clientUuid = SCRIPT_PROPS.getProperty('CLIENT_UUID');
  if (!clientUuid) {
    clientUuid = Utilities.getUuid(); // Generate a new UUID
    SCRIPT_PROPS.setProperty('CLIENT_UUID', clientUuid);
    Logger.log("Generated and stored new CLIENT_UUID: " + clientUuid);
  }
  return clientUuid;
}

// --- Helper Function to Parse Set-Cookie Headers ---
/**
 * Parses the Set-Cookie header(s) from UrlFetchApp response headers
 * into a single Cookie header string suitable for subsequent requests.
 * @param {Object|string|string[]} setCookieHeader The value from response.getHeaders()['Set-Cookie'] or similar key.
 * @return {string} A string formatted for the 'Cookie' request header, e.g., "key1=value1; key2=value2". Returns empty string if no cookies found.
 */
function parseSetCookieHeaders(setCookieHeader) {
  if (!setCookieHeader) {
    return "";
  }

  var cookies = [];
  var headers = [];

  if (Array.isArray(setCookieHeader)) {
    headers = setCookieHeader;
  } else if (typeof setCookieHeader === 'string') {
    // Handle potential joining of multiple headers in one string (less common in GAS)
     headers = setCookieHeader.split(/,\s*(?=[^;]+?=)/); // Split by comma only if followed by key= (avoids splitting expires dates)
  } else {
     Logger.log("Warning: Unexpected Set-Cookie header type: " + (typeof setCookieHeader));
     return "";
  }

  headers.forEach(function(header) {
    if (typeof header === 'string') {
       // Extract only the first key=value pair, ignoring attributes like Path, Expires, HttpOnly etc.
       var parts = header.split(';');
       if (parts.length > 0 && parts[0].includes('=')) {
          // Trim whitespace from the key=value part
          cookies.push(parts[0].trim());
       }
    }
  });

   var cookieString = cookies.join('; '); // Join multiple cookies with '; '
   Logger.log("Parsed cookies for request header: " + cookieString);
   return cookieString;
}


/**
 * Wrapper function to update location data for Milkdud3.
 */
function updateMilkdud3Location() {
  TILE_NAME = 'Milkdud3';
  SHEET_NAME = 'Milkdud3';
  updateTileLocationData();
}

/**
 * Wrapper function to update location data for Milkdud4.
 */
function updateMilkdud4Location() {
  TILE_NAME = 'Milkdud4';
  SHEET_NAME = 'Milkdud4';
  updateTileLocationData();
}

// --- Main Function ---
/**
 * Main function to orchestrate fetching Tile data and updating the sheet.
 */
function updateTileLocationData() {
  // Verify essential configuration is present
  if (!TILE_EMAIL || !TILE_PASSWORD || !TILE_NAME || !SPREADSHEET_ID || !SHEET_NAME) {
    Logger.log("ERROR: Script properties (TILE_EMAIL, TILE_PASSWORD, TILE_NAME, SPREADSHEET_ID, SHEET_NAME) are not set correctly.");
    try { SpreadsheetApp.getUi().alert("ERROR: Script properties are not set."); } catch (uiError) {}
    return;
  }
  Logger.log("Starting Tile location update for Tile: " + TILE_NAME + " (User: " + TILE_EMAIL + ")");

  var ss = null;
  var sheet = null;
  var clientUuid = getClientUuid(); // Get or generate Client UUID

  try {
    // --- Setup Sheet ---
    Logger.log("Accessing Spreadsheet ID: '" + SPREADSHEET_ID + "'");
     if (typeof SPREADSHEET_ID !== 'string' || SPREADSHEET_ID.trim() === "") {
       Logger.log("ERROR: Invalid SPREADSHEET_ID retrieved from properties.");
       try { SpreadsheetApp.getUi().alert("ERROR: The SPREADSHEET_ID script property is missing or invalid."); } catch (uiError) {}
       return;
     }
    ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      // Add headers if the sheet is new
      sheet.appendRow(['timestamp', 'latitude', 'longitude']);
      SpreadsheetApp.flush(); // Ensure sheet changes are saved before proceeding
      Logger.log("Created new sheet: " + SHEET_NAME);
    }


    // --- Calculate Time Range ---
    var latestTimestamp = getLatestTimestampFromSheet(sheet);
    var startTime = null;
    var endTime = new Date(); // Now
    if (latestTimestamp) {
      // Fetch data since the last recorded time, minus a buffer to avoid gaps
      startTime = new Date(latestTimestamp.getTime() - 5 * 60 * 1000); // Subtract 5 minutes buffer
      Logger.log("Fetching history since (approx): " + startTime.toISOString());
       // Ensure start time is not in the future
       if (startTime.getTime() > endTime.getTime()) {
         Logger.log("Warning: Calculated start time is in the future. Adjusting to 1 hour ago.");
         startTime = new Date(endTime.getTime() - 60 * 60 * 1000); // 1 hour ago
       }
    } else {
      // No cache, fetch last 120 days (or desired default)
      startTime = new Date(endTime.getTime() - 120 * 24 * 60 * 60 * 1000); // 120 days ago default
      Logger.log("No cache found or cache empty. Fetching history for the last 7 days ("+ startTime.toISOString() + " to " + endTime.toISOString() +")");
    }


    // --- Authenticate with Tile API (2-Step Login & Get Cookies) ---
    var authInfo = establishSessionAndGetCookies(clientUuid, TILE_EMAIL, TILE_PASSWORD);
    if (!authInfo || !authInfo.cookies) { // Check for cookies specifically
      Logger.log("ERROR: Failed to establish session or get cookies from Tile API. Stopping execution.");
      return;
    }
    Logger.log("Successfully established session and obtained cookies.");


    // --- Get Tile UUID ---
    var tileUuid = getTileUuidByName(clientUuid, authInfo, TILE_NAME); // Pass clientUuid and authInfo (with cookies)
     if (!tileUuid) {
      Logger.log("ERROR: Failed to find Tile UUID for name: '" + TILE_NAME + "'. Stopping execution.");
      return;
    }
    Logger.log("Found UUID: '" + tileUuid + "' for Tile: '" + TILE_NAME + "'");


    // --- Fetch Location History from Tile API ---
    // Pass clientUuid and authInfo (with cookies)
    var historyResponse = fetchTileHistoryFromAPI(clientUuid, authInfo, tileUuid, startTime, endTime);
    if (historyResponse === null) { // Check specifically for null (indicates fetch failure)
      Logger.log("Stopping execution due to history fetch failure.");
      return;
    }
     Logger.log("Successfully fetched raw history data object.");


    // --- Process History Data ---
    // Process the response object returned by fetchTileHistoryFromAPI
    var newData = processHistoryData(historyResponse);
    Logger.log("Processed " + newData.length + " new location entries.");


    // --- Update Google Sheet ---
    if (newData.length > 0) {
      updateSheet(sheet, newData);
      Logger.log("Successfully updated sheet.");
    } else {
      Logger.log("No new, unique location entries found to add to the sheet.");
    }

    Logger.log("Tile location update finished successfully.");

  } catch (error) {
    Logger.log("FATAL ERROR in updateTileLocationData: " + error);
    Logger.log("Stack Trace: " + error.stack);
    // Optional: Send an email notification on failure
    // MailApp.sendEmail("your_alert_email@example.com", "Tile Tracker Script Failed", "Error: " + error + "\nStack: " + error.stack);
  }
}


// --- Helper Functions (getLatestTimestampFromSheet, updateSheet - Unchanged) ---

/**
 * Reads the sheet and finds the latest timestamp. (No changes from previous version)
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet The Google Sheet object.
 * @return {Date|null} The latest Date object found, or null if no data/error.
 */
function getLatestTimestampFromSheet(sheet) {
  // ... (code is identical to the previous version) ...
  try {
    var dataRange = sheet.getDataRange();
    var values = dataRange.getValues();
    if (values.length <= 1) { Logger.log("Sheet is empty or contains only headers. No latest timestamp found."); return null; }
    var latestTimestampMillis = 0;
    // Start from 1 to skip header row
    for (var i = 1; i < values.length; i++) {
      var timestampCell = values[i][0]; // Assuming timestamp is in column A (index 0)
      if (!timestampCell) continue; // Skip empty cells

      var currentMillis = 0;
      if (timestampCell instanceof Date) {
         currentMillis = timestampCell.getTime();
      } else {
         // Try parsing if it's not already a Date (e.g., read as string/number)
         var parsedDate = new Date(timestampCell);
         if (!isNaN(parsedDate.getTime())) {
             currentMillis = parsedDate.getTime();
         } else {
            // Logger.log("Warning: Could not parse date in cell A" + (i+1) + ": " + timestampCell);
         }
      }

      if (currentMillis > latestTimestampMillis) {
        latestTimestampMillis = currentMillis;
      }
    }

    if (latestTimestampMillis > 0) {
      var latestDate = new Date(latestTimestampMillis);
      Logger.log("Latest timestamp found in sheet: " + latestDate.toISOString());
      return latestDate;
    } else {
      Logger.log("No valid timestamps found in sheet data.");
      return null;
    }
  } catch (e) {
    Logger.log("Error reading latest timestamp from sheet: " + e);
    return null;
  }
}

/**
 * Appends new data rows to the sheet, avoiding duplicates based on timestamp. Sorts afterwards. (No changes from previous version)
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet The Google Sheet object.
 * @param {Array[]} newData An array of new rows, e.g., [[timestampDate, lat, lon], ...].
 */
function updateSheet(sheet, newData) {
  // ... (code is identical to the previous version) ...
   if (!newData || newData.length === 0) { Logger.log("updateSheet: No new data provided."); return; }
  try {
    var dataRange = sheet.getDataRange(); var values = dataRange.getValues(); var existingTimestamps = new Set(); var numHeaderRows = 1;
    // Populate set with existing timestamps (milliseconds)
    for (var i = numHeaderRows; i < values.length; i++) {
      var tsCell = values[i][0]; // Assuming timestamp is in column A
      if (!tsCell) continue; // Skip empty cells

      if (tsCell instanceof Date) {
        existingTimestamps.add(tsCell.getTime());
      } else {
         var parsedDate = new Date(tsCell);
         if (!isNaN(parsedDate.getTime())) {
             existingTimestamps.add(parsedDate.getTime());
         }
      }
    }
    Logger.log("Found " + existingTimestamps.size + " existing timestamps in the sheet.");
    var rowsToAdd = []; var addedCount = 0;
    for (var j = 0; j < newData.length; j++) {
      var newRow = newData[j]; var newTimestamp = newRow[0]; // Assuming timestamp Date object is the first element
      if (!(newTimestamp instanceof Date) || isNaN(newTimestamp.getTime())) { Logger.log("Warning: Skipping invalid date in new data row " + j); continue; }
      var tsMillis = newTimestamp.getTime();
      if (!existingTimestamps.has(tsMillis)) { rowsToAdd.push(newRow); existingTimestamps.add(tsMillis); addedCount++; }
    }
    if (rowsToAdd.length > 0) {
       Logger.log("Attempting to append " + rowsToAdd.length + " new unique rows.");
       sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAdd.length, rowsToAdd[0].length).setValues(rowsToAdd);
       Logger.log("Appended " + rowsToAdd.length + " rows.");
       var lastRowToSort = sheet.getLastRow();
       if (lastRowToSort > numHeaderRows) {
           sheet.getRange(numHeaderRows + 1, 1, lastRowToSort - numHeaderRows, sheet.getLastColumn())
                .sort({column: 1, ascending: true}); // Sort data rows only (excluding header)
           Logger.log("Sorted sheet by timestamp (Column 1).");
       } else { Logger.log("Skipping sort: Not enough data rows."); }
    } else { Logger.log("No unique new rows found to add."); }
  } catch (e) { Logger.log("Error updating sheet: " + e); Logger.log("Error Stack: " + e.stack); }
}

// --- CORRECTED processHistoryData Function ---
/**
 * Processes the raw history data object from the Tile API into a structured array for the sheet.
 * Extracts location points from the 'result.location_updates' array within the input object. // <-- Corrected path description
 * @param {Object} historyResponse Raw data object from the Tile API fetch, expected to have a 'result.location_updates' property containing an array.
 * @return {Array[]} Array of rows: [[timestampDate, latitude, longitude], ...]. Returns empty array on error or if no data found.
 */
function processHistoryData(historyResponse) {
  var records = [];
  var entries = [];

  // CORRECTED CHECK: Look for result.location_updates as the array
  if (historyResponse && historyResponse.result && Array.isArray(historyResponse.result.location_updates)) {
      entries = historyResponse.result.location_updates; // Assign the correct array
      Logger.log("Found " + entries.length + " entries in historyResponse.result.location_updates array.");
  } else {
     Logger.log("Warning: Could not find 'result.location_updates' array in historyData structure or historyResponse was null/invalid.");
     // Log the structure without assuming 'result' exists if the primary check failed
     var responseSample = historyResponse ? JSON.stringify(historyResponse).substring(0, 500) : "null response";
     Logger.log("Received data structure sample: " + responseSample);
     return []; // Return empty if structure is wrong or data is null
  }

  // --- The rest of the processing loop remains the same ---
  var successfulPoints = 0; var warningCount = 0; var maxWarnings = 5;
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i]; if (!entry || typeof entry !== 'object') { if (warningCount < maxWarnings) Logger.log("Warning: Skipping invalid entry at index " + i); warningCount++; continue; }
    try {
      // Key names seem consistent with the logged sample ('location_timestamp', 'latitude', 'longitude')
      var timestampMillis = entry.location_timestamp || entry.timestamp;
      var latitude = entry.latitude || entry.lat;
      var longitude = entry.longitude || entry.lng || entry.lon;
      if (timestampMillis && latitude != null && longitude != null) { // Check for null/undefined specifically
         // Ensure timestamp is a number
         var tsNum = Number(timestampMillis);
         var latFloat = parseFloat(latitude);
         var lonFloat = parseFloat(longitude);
         // Basic validation
         if (!isNaN(tsNum) && tsNum > 0 &&
             !isNaN(latFloat) && !isNaN(lonFloat) &&
             latFloat >= -90 && latFloat <= 90 && lonFloat >= -180 && lonFloat <= 180)
         {
             var timestampDate = new Date(tsNum); // Create Date object from valid millis
             records.push([timestampDate, latFloat, lonFloat]);
             successfulPoints++;
         } else {
            if (warningCount < maxWarnings) {
               Logger.log("Warning: Invalid data values - Timestamp: " + timestampMillis + " ("+tsNum+"), Lat: " + latitude + " ("+latFloat+"), Lon: " + longitude + " ("+lonFloat+")");
            }
            warningCount++;
         }
      } else {
         if (warningCount < maxWarnings) {
            Logger.log("Warning: Missing data fields in entry: " + JSON.stringify(entry));
         }
         warningCount++;
      }
    } catch (e) {
       if (warningCount < maxWarnings) {
          Logger.log("Error processing entry: " + e + " - Entry: " + JSON.stringify(entry));
       }
       warningCount++;
    }
  }
  if (warningCount > maxWarnings) {
      Logger.log("... additional " + (warningCount - maxWarnings) + " processing warnings suppressed.");
  }
  Logger.log("Successfully processed " + successfulPoints + " valid location points from API response.");
  return records;
}


// --- Tile API Interaction Functions (Unchanged from previous version) ---

/**
 * Establishes a session with the Tile API (2-step) and captures authentication cookies.
 * @param {string} clientUuid The unique identifier for this client.
 * @param {string} email User's Tile email.
 * @param {string} password User's Tile password.
 * @return {Object|null} Object containing { userUuid: string, cookies: string } on success, or null on failure.
 */
function establishSessionAndGetCookies(clientUuid, email, password) {
  var headersStep1 = {
    'User-Agent': TILE_USER_AGENT,
    'tile_api_version': TILE_API_VERSION,
    'tile_app_id': TILE_APP_ID,
    'tile_app_version': TILE_APP_VERSION,
    'tile_client_uuid': clientUuid
    // No Content-Type needed for form-encoded payload below
  };
  var payloadStep1 = { // Payload for PUT client - form encoded by UrlFetchApp
    'app_id': TILE_APP_ID,
    'app_version': TILE_APP_VERSION,
    'locale': TILE_LOCALE
  };
  var optionsStep1 = {
    'method': 'put',
    'headers': headersStep1,
    'payload': payloadStep1,
    'muteHttpExceptions': true
  };
  var urlStep1 = BASE_API_URL + "/clients/" + clientUuid;

  try {
    // --- Step 1: Register/Establish Client ---
    Logger.log("Attempting PUT Client to: " + urlStep1);
    var responseStep1 = UrlFetchApp.fetch(urlStep1, optionsStep1);
    var responseCodeStep1 = responseStep1.getResponseCode();
    Logger.log("PUT Client Response Code: " + responseCodeStep1);
    // Logger.log("PUT Client Response Body: " + responseStep1.getContentText()); // Usually empty on success

    // Check for success (e.g., 200 OK, 201 Created, or 204 No Content)
    if (responseCodeStep1 < 200 || responseCodeStep1 >= 300) {
      Logger.log("PUT Client failed: HTTP " + responseCodeStep1 + ". Body: " + responseStep1.getContentText().substring(0,500));
      return null;
    }
    Logger.log("PUT Client successful.");

    // --- Step 2: Create Session (Login) ---
     var headersStep2 = { // Headers are the same as step 1 for consistency
        'User-Agent': TILE_USER_AGENT,
        'tile_api_version': TILE_API_VERSION,
        'tile_app_id': TILE_APP_ID,
        'tile_app_version': TILE_APP_VERSION,
        'tile_client_uuid': clientUuid
        // No Content-Type needed for form-encoded payload
     };
     var payloadStep2 = { // Payload for POST session - form encoded
        'email': email,
        'password': password
     };
     var optionsStep2 = {
        'method': 'post',
        'headers': headersStep2,
        'payload': payloadStep2,
        'muteHttpExceptions': true
     };
     var urlStep2 = BASE_API_URL + "/clients/" + clientUuid + "/sessions";

     Logger.log("Attempting POST Session to: " + urlStep2);
     var responseStep2 = UrlFetchApp.fetch(urlStep2, optionsStep2);
     var responseCodeStep2 = responseStep2.getResponseCode();
     var responseBodyStep2 = responseStep2.getContentText();
     var responseHeadersStep2 = responseStep2.getHeaders(); // Get all headers
     Logger.log("POST Session Response Code: " + responseCodeStep2);

     if (responseCodeStep2 >= 200 && responseCodeStep2 < 300) {
        var jsonResponse = JSON.parse(responseBodyStep2);
        // Check for expected data in response
        if (jsonResponse && jsonResponse.result && jsonResponse.result.user && jsonResponse.result.user.user_uuid) {
           // CRITICAL: Capture and parse cookies
           // Header key might be 'Set-Cookie' or 'set-cookie'
           var setCookieHeader = responseHeadersStep2['Set-Cookie'] || responseHeadersStep2['set-cookie'];
           var cookieString = parseSetCookieHeaders(setCookieHeader);

           if (!cookieString) {
               Logger.log("Warning: POST Session successful, but no Set-Cookie header found or parsed. Subsequent requests might fail.");
               // Proceed anyway, but log warning
           } else {
               Logger.log("Successfully parsed cookies.");
           }

           return {
              userUuid: jsonResponse.result.user.user_uuid,
              cookies: cookieString // Return the parsed cookie string
           };
        } else {
           Logger.log("POST Session failed: user_uuid not found in expected response structure. Body sample: " + responseBodyStep2.substring(0, 500));
           return null;
        }
     } else {
        Logger.log("POST Session failed: HTTP " + responseCodeStep2 + ". Body sample: " + responseBodyStep2.substring(0, 500));
        return null;
     }

  } catch (e) {
    Logger.log("Establish session exception: " + e);
    Logger.log("Stack: " + e.stack);
    return null;
  }
}


/**
 * Gets the Tile's unique identifier (UUID) based on its name using the revised API flow.
 * @param {string} clientUuid The unique identifier for this client.
 * @param {Object} authInfo Authentication info object containing { cookies: string }.
 * @param {string} tileName The exact name of the Tile device.
 * @return {string|null} The Tile UUID string on success, or null on failure/not found.
 */
function getTileUuidByName(clientUuid, authInfo, tileName) {
  if (!authInfo || !authInfo.cookies) {
     Logger.log("getTileUuidByName Error: Missing authInfo.cookies");
     return null;
  }

  // --- Step 1: Get Tile States ---
  var urlStates = BASE_API_URL + "/tiles/tile_states";
  var headers = { // Base headers + Cookie
     'User-Agent': TILE_USER_AGENT,
     'tile_api_version': TILE_API_VERSION,
     'tile_app_id': TILE_APP_ID,
     'tile_app_version': TILE_APP_VERSION,
     'tile_client_uuid': clientUuid,
     'Cookie': authInfo.cookies // Add the captured cookies
  };
  var optionsStates = {
    'method': 'get',
    'headers': headers,
    'muteHttpExceptions': true
  };

  var tileIds = [];
  try {
     Logger.log("Attempting GET Tile States from: " + urlStates);
     var responseStates = UrlFetchApp.fetch(urlStates, optionsStates);
     var responseCodeStates = responseStates.getResponseCode();
     var responseBodyStates = responseStates.getContentText();
     Logger.log("Get Tile States Response Code: " + responseCodeStates);

     if (responseCodeStates === 200) {
        var jsonStates = JSON.parse(responseBodyStates);
        if (jsonStates && Array.isArray(jsonStates.result)) {
           tileIds = jsonStates.result.map(function(tileState) { return tileState.tile_id; });
           Logger.log("Found " + tileIds.length + " tile IDs from tile_states.");
        } else {
           Logger.log("Get Tile States failed: 'result' array not found or invalid. Body sample: " + responseBodyStates.substring(0,500));
           return null;
        }
     } else {
        Logger.log("Get Tile States failed: HTTP " + responseCodeStates + ". Body sample: " + responseBodyStates.substring(0, 500));
        return null;
     }
  } catch (e) {
     Logger.log("Get Tile States exception: " + e);
     Logger.log("Stack: " + e.stack);
     return null;
  }

  if (tileIds.length === 0) {
      Logger.log("No tile IDs found, cannot search for name.");
      return null;
  }

  // --- Step 2: Get Details for Each Tile to Find Name ---
  Logger.log("Fetching details for each tile to find name: '" + tileName + "'");
  for (var i = 0; i < tileIds.length; i++) {
     var currentTileUuid = tileIds[i];
     if (!currentTileUuid) { continue; } // Skip if somehow a null/empty ID got in
     var urlDetails = BASE_API_URL + "/tiles/" + currentTileUuid;
     var optionsDetails = { // Headers are the same (include Cookie)
        'method': 'get',
        'headers': headers, // Reuse headers object from above (includes Cookie)
        'muteHttpExceptions': true
     };

     try {
        //Logger.log("Attempting GET Tile Details for: " + currentTileUuid); // Can be very verbose
        var responseDetails = UrlFetchApp.fetch(urlDetails, optionsDetails);
        var responseCodeDetails = responseDetails.getResponseCode();
        var responseBodyDetails = responseDetails.getContentText();

        // Handle Tile Labels which return 412 Precondition Failed (as noted in pytile)
        if (responseCodeDetails === 412) {
            //Logger.log("Skipping Tile " + currentTileUuid + " (likely a label, HTTP 412)");
            continue; // Skip this one, it doesn't have full details
        }

        if (responseCodeDetails === 200) {
           var jsonDetails = JSON.parse(responseBodyDetails);
           if (jsonDetails && jsonDetails.result && jsonDetails.result.name === tileName) {
              Logger.log("Found matching Tile UUID: " + currentTileUuid + " for name: '" + tileName + "'");
              return currentTileUuid; // Found it!
           }
            // else { Logger.log("Tile " + currentTileUuid + " name mismatch: '" + (jsonDetails && jsonDetails.result ? jsonDetails.result.name : 'N/A') + "'"); }
        } else {
           // Don't log every failure here unless debugging, can be noisy if some tiles are deactivated
           // Logger.log("Get Tile Details failed for " + currentTileUuid + ": HTTP " + responseCodeDetails + ". Body sample: " + responseBodyDetails.substring(0, 300));
           // Don't stop the loop, continue checking other tiles
        }
     } catch (e) {
        Logger.log("Get Tile Details exception for " + currentTileUuid + ": " + e);
        // Continue checking other tiles
     }
     // Optional: Add a small sleep to avoid hitting rate limits if there are many tiles
     // Utilities.sleep(100);
  }

  // If loop finishes without finding the name
  Logger.log("Tile UUID not found after checking details for all tiles with name: '" + tileName + "'");
  return null;
}


/**
 * Fetches location history for a specific Tile UUID using cookies for auth.
 * @param {string} clientUuid The unique identifier for this client.
 * @param {Object} authInfo Authentication info object containing { cookies: string }.
 * @param {string} tileUuid The unique identifier (UUID) of the Tile.
 * @param {Date} startTime The start time for the history fetch.
 * @param {Date} endTime The end time for the history fetch.
 * @return {Object|null} Raw history response object or null on failure.
 */
function fetchTileHistoryFromAPI(clientUuid, authInfo, tileUuid, startTime, endTime) {
   if (!authInfo || !authInfo.cookies) { Logger.log("fetchTileHistoryFromAPI Error: Missing authInfo.cookies"); return null; }
   if (!tileUuid) { Logger.log("fetchTileHistoryFromAPI Error: Missing tileUuid"); return null; }
   if (!(startTime instanceof Date) || !(endTime instanceof Date)) { Logger.log("fetchTileHistoryFromAPI Error: Invalid startTime or endTime"); return null; }

   var startTimeMillis = startTime.getTime();
   var endTimeMillis = endTime.getTime();
   // CORRECTED URL construction with /location/
   var url = Utilities.formatString(BASE_API_URL + "/tiles/location/history/%s?start_timestamp_ms=%s&end_timestamp_ms=%s",
                                   tileUuid, startTimeMillis, endTimeMillis);
   var headers = { // Base headers + Cookie
     'User-Agent': TILE_USER_AGENT,
     'tile_api_version': TILE_API_VERSION,
     'tile_app_id': TILE_APP_ID,
     'tile_app_version': TILE_APP_VERSION,
     'tile_client_uuid': clientUuid,
     'Cookie': authInfo.cookies // Add the captured cookies
  };
   var options = {
     'method': 'get',
     'headers': headers,
     'muteHttpExceptions': true
   };

   try {
     Logger.log("Attempting GET History from: " + url);
     var response = UrlFetchApp.fetch(url, options);
     var responseCode = response.getResponseCode();
     var responseBody = response.getContentText();
     Logger.log("Get History Response Code: " + responseCode);

     if (responseCode === 200) {
       var jsonResponse = JSON.parse(responseBody);
       // Check if the expected structure is present before returning
       if (jsonResponse && jsonResponse.hasOwnProperty('result') && jsonResponse.result.hasOwnProperty('location_updates')) {
          var resultLength = Array.isArray(jsonResponse.result.location_updates) ? jsonResponse.result.location_updates.length : 'N/A';
          Logger.log("Tile history fetch successful. Found " + resultLength + " items in result.location_updates.");
          return jsonResponse; // Return the whole object
       } else {
          Logger.log("Tile history fetch warning: 'result.location_updates' structure not found or invalid. Body sample: " + responseBody.substring(0,500));
          return { result: { location_updates: [] } }; // Return empty but valid structure
       }
     } else {
       Logger.log("Tile history fetch failed: HTTP " + responseCode + ". Body sample: " + responseBody.substring(0, 500));
       return null; // Indicate failure
     }
   } catch (e) {
     Logger.log("Tile history fetch exception: " + e);
     Logger.log("Stack: " + e.stack);
     return null; // Indicate failure
   }
}