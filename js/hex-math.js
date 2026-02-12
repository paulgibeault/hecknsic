/**
 * hex-math.js — Coordinate conversions and neighbor lookup for flat-top
 * hexagons using the odd-q offset coordinate system.
 */

import { HEX_SIZE } from './constants.js';

const SQRT3 = Math.sqrt(3);

// ─── Offset (odd-q) ↔ Pixel ────────────────────────────────────

/**
 * Convert grid (col, row) to pixel center.
 * @param {number} col
 * @param {number} row
 * @param {number} originX  – pixel x of grid origin (col=0, row=0)
 * @param {number} originY  – pixel y of grid origin
 * @returns {{ x: number, y: number }}
 */
export function hexToPixel(col, row, originX, originY) {
  const x = originX + col * HEX_SIZE * 1.5;
  const y = originY + row * SQRT3 * HEX_SIZE
            + (col & 1 ? SQRT3 / 2 * HEX_SIZE : 0);
  return { x, y };
}

// ─── Pixel → Offset (odd-q) ────────────────────────────────────

/**
 * Convert a pixel coordinate to the nearest grid (col, row).
 */
export function pixelToHex(px, py, originX, originY) {
  // Convert to fractional axial coordinates
  const qFrac = (2 / 3 * (px - originX)) / HEX_SIZE;
  const rFrac = (-1 / 3 * (px - originX) + SQRT3 / 3 * (py - originY)) / HEX_SIZE;
  const { q, r } = axialRound(qFrac, rFrac);
  return axialToOffset(q, r);
}

/**
 * Round fractional axial coords to nearest hex.
 */
function axialRound(qFrac, rFrac) {
  const sFrac = -qFrac - rFrac;
  let q = Math.round(qFrac);
  let r = Math.round(rFrac);
  let s = Math.round(sFrac);
  const qDiff = Math.abs(q - qFrac);
  const rDiff = Math.abs(r - rFrac);
  const sDiff = Math.abs(s - sFrac);
  if (qDiff > rDiff && qDiff > sDiff) {
    q = -r - s;
  } else if (rDiff > sDiff) {
    r = -q - s;
  }
  return { q, r };
}

/**
 * Axial (q, r) → offset (col, row) for odd-q.
 */
function axialToOffset(q, r) {
  const col = q;
  const row = r + (q - (q & 1)) / 2;
  return { col, row };
}

/**
 * Offset (col, row) → axial (q, r).
 */
export function offsetToAxial(col, row) {
  const q = col;
  const r = row - (col - (col & 1)) / 2;
  return { q, r };
}

// ─── Neighbors ──────────────────────────────────────────────────

const NEIGHBORS_EVEN = [
  [+1,  0], [+1, -1], [ 0, -1],
  [-1, -1], [-1,  0], [ 0, +1],
];
const NEIGHBORS_ODD = [
  [+1, +1], [+1,  0], [ 0, -1],
  [-1,  0], [-1, +1], [ 0, +1],
];

/**
 * Get all 6 neighbor coords of (col, row).
 * @returns {Array<{col: number, row: number}>}
 */
export function getNeighbors(col, row) {
  const table = (col & 1) ? NEIGHBORS_ODD : NEIGHBORS_EVEN;
  return table.map(([dc, dr]) => ({ col: col + dc, row: row + dr }));
}

// ─── Cluster (3-hex triangle around a vertex) ───────────────────

/**
 * Given a pixel position near the board, find the best cluster of 3
 * hexes to highlight.  The cluster is the triangle of 3 hexes sharing
 * the vertex closest to the cursor.
 *
 * Returns an array of 3 {col, row} objects, or null if not on the board.
 */
export function findClusterAtPixel(px, py, originX, originY, gridCols, gridRows) {
  // Find the hex the cursor is inside
  const center = pixelToHex(px, py, originX, originY);

  // Get all 6 neighbors
  const neighbors = getNeighbors(center.col, center.row);

  // Build candidate clusters: each cluster = [center, neighbor[i], neighbor[(i+1)%6]]
  let bestCluster = null;
  let bestDist = Infinity;

  for (let i = 0; i < 6; i++) {
    const a = center;
    const b = neighbors[i];
    const c = neighbors[(i + 1) % 6];

    // Check all three are in bounds
    if (!inBounds(a, gridCols, gridRows) ||
        !inBounds(b, gridCols, gridRows) ||
        !inBounds(c, gridCols, gridRows)) continue;

    // Compute the centroid of the three hexes in pixel space
    const pA = hexToPixel(a.col, a.row, originX, originY);
    const pB = hexToPixel(b.col, b.row, originX, originY);
    const pC = hexToPixel(c.col, c.row, originX, originY);
    const cx = (pA.x + pB.x + pC.x) / 3;
    const cy = (pA.y + pB.y + pC.y) / 3;
    const dist = (px - cx) ** 2 + (py - cy) ** 2;

    if (dist < bestDist) {
      bestDist = dist;
      bestCluster = [a, b, c];
    }
  }

  return bestCluster;
}

function inBounds(hex, cols, rows) {
  return hex.col >= 0 && hex.col < cols && hex.row >= 0 && hex.row < rows;
}

// ─── Flat-top hex polygon points ────────────────────────────────

/**
 * Get the 6 vertices of a flat-top hex centered at (cx, cy).
 * @returns {Array<{x: number, y: number}>}
 */
export function hexCorners(cx, cy, size) {
  const corners = [];
  for (let i = 0; i < 6; i++) {
    const angleDeg = 60 * i;
    const angleRad = Math.PI / 180 * angleDeg;
    corners.push({
      x: cx + size * Math.cos(angleRad),
      y: cy + size * Math.sin(angleRad),
    });
  }
  return corners;
}
