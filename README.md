
# Tile Tracker Google Apps Script

Tile Tracker is a Google Apps Script project designed to fetch and track the location history of a specified Tile device using Tile's APIs. It handles the complexities of interacting with Tile's services, including authentication, cookie management, and data caching.

## Features

*   **Tile API Integration:** Fetches location history directly from Tile APIs.
*   **Authentication:** Implements the required headers and 2-step login process for secure access.
*   **Cookie Handling:** Manages session cookies to maintain authenticated access to Tile's services.
*   **Data Caching:** Stores fetched location data in a Google Sheet for easy access and historical tracking.
*   **Customizable:** Allows specifying the Tile device for which location history is tracked.

## Environment Setup

### Prerequisites

*   A Google account with access to Google Sheets and Google Apps Script.
*   A Tile account with a Tile device registered.

### Script Properties

Before running the script, you need to set the following script properties within the Google Apps Script editor:

*   **`TILE_USERNAME`**: Your Tile account username (email).
*   **`TILE_PASSWORD`**: Your Tile account password.
*   **`TILE_DEVICE_ID`**: The ID of the Tile device you want to track.
*   **`TILE_2FA_CODE`**: This property is initially set to an empty string, and the script will prompt you for a code on the first run.
*   **`SHEET_ID`**: ID of the Google Sheet to store data.

### Installation

1.  Create a new Google Sheet.
2.  Open the Google Apps Script editor from the sheet (Tools > Script editor).
3.  Copy and paste the `Code.js` content into the script editor.
4.  Go to "Project Settings" and enable the "Show 'appscript.json' file in editor" checkbox.
5.  Update the script properties with your Tile account details and the Google Sheet ID.

### Usage

1.  Run the `main` function from the Google Apps Script editor.
2.  Authorize the script when prompted.
3.  The script will log in to Tile, fetch location data, and write it to the specified Google Sheet.

## Contributing

Contributions are welcome! Please feel free to fork the repository, make your changes, and submit a pull request.

## License

This project is open-source and available under the [Specify License Here] license.
