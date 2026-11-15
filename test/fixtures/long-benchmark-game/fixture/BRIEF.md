# Lights Out

Build the puzzle game Lights Out as a web page in this folder.

## Files

- The entry page is `index.html`.
- Use plain HTML, CSS and JavaScript. Do not use a build step, a framework or
  any external resource (no CDN, font or image from another site).
- You can put the CSS and JavaScript in `index.html` or in other files in this
  folder. Refer to other files with relative paths.

## Rules

- The board is a grid of 5 rows and 5 columns of lights. Each light is on or
  off.
- When the player clicks a light, that light and the lights directly above,
  below, left and right of it change state (on becomes off, off becomes on).
  A light on an edge or in a corner has fewer neighbours. The board does not
  wrap around.
- The game starts with this pattern, top row first (`1` is on, `0` is off):

  ```text
  11110
  11011
  10101
  11111
  11101
  ```

- A move counter shows how many lights the player has clicked since the start.
- When every light is off, the puzzle is solved. Show the text
  `Solved in N moves`, where `N` is the move count. After that, clicks on
  lights have no effect until the player restarts.
- An Undo button reverses the last move and decreases the move counter by one.
  It is disabled when there is no move to undo.
- A Restart button restores the starting pattern, sets the move counter to 0
  and clears the solved message.

## Page structure

Other code reads the page through these elements. Keep them exactly:

- An element with the id `board` contains the 25 lights.
- Each light is a `<button>` with the attributes `data-row` and `data-col`
  (each from `0` to `4`, top-left is row 0, column 0) and the attribute
  `aria-pressed`: `"true"` when the light is on, `"false"` when it is off.
- A light that is on and a light that is off have different background colours.
- An element with the id `moves` shows the move counter as a number.
- An element with the id `status` shows the solved message.
- The Undo button has the id `undo`. The Restart button has the id `restart`.
