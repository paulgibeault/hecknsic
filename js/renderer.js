/**
 * renderer.js — Draw the hex board with glossy beveled hexagons,
 * dark metallic frame, cursor highlights, and HUD.
 *
 * Supports per-cell animation overrides (scale, alpha, offsetY)
 * and free-floating animated pieces.
 */

import {
  GRID_COLS, GRID_ROWS, HEX_SIZE, PIECE_COLORS, STARFLOWER_COLOR,
  FRAME_COLOR, BOARD_BG_COLOR, TEXT_COLOR,
  HIGHLIGHT_COLOR, CLUSTER_HIGHLIGHT,
} from './constants.js';
import { hexToPixel, hexCorners } from './hex-math.js';
import { getDisplayScore, getComboCount, getChainLevel } from './score.js';

// ─── Module state ───────────────────────────────────────────────
let ctx;
let canvasW, canvasH;
let originX, originY;

// Per-cell animation overrides: "col,row" → { scale?, alpha?, offsetX?, offsetY?, hidden? }
let cellOverrides = {};

// Free-floating pieces drawn on top (for rotation arcs, etc.)
let floatingPieces = [];  // { x, y, colorIndex, scale, alpha }

export function initRenderer(canvas) {
  ctx = canvas.getContext('2d');
  resize(canvas);
}

export function resize(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvasW = rect.width;
  canvasH = rect.height;
  canvas.width = canvasW * dpr;
  canvas.height = canvasH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  recalcOrigin();
}

function recalcOrigin() {
  const gridPixelW = (GRID_COLS - 1) * HEX_SIZE * 1.5 + HEX_SIZE * 2;
  const gridPixelH = GRID_ROWS * Math.sqrt(3) * HEX_SIZE + Math.sqrt(3) / 2 * HEX_SIZE;
  originX = (canvasW - gridPixelW) / 2 + HEX_SIZE;
  originY = (canvasH - gridPixelH) / 2 + Math.sqrt(3) / 2 * HEX_SIZE + 30;
}

export function getOrigin() {
  return { originX, originY };
}

// ─── Override API ───────────────────────────────────────────────

export function setCellOverride(col, row, override) {
  cellOverrides[`${col},${row}`] = override;
}

export function clearCellOverride(col, row) {
  delete cellOverrides[`${col},${row}`];
}

export function clearAllOverrides() {
  cellOverrides = {};
  floatingPieces = [];
}

export function addFloatingPiece(piece) {
  floatingPieces.push(piece);
  return piece;
}

export function removeFloatingPiece(piece) {
  const idx = floatingPieces.indexOf(piece);
  if (idx >= 0) floatingPieces.splice(idx, 1);
}

// ─── Main draw ──────────────────────────────────────────────────

export function drawFrame(grid, hoverCluster, selectedCluster) {
  // Clear
  ctx.fillStyle = FRAME_COLOR;
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Board background
  drawBoardBackground();

  // Grid hexes
  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      const cell = grid[c][r];
      if (cell === null) continue;

      const override = cellOverrides[`${c},${r}`];
      if (override && override.hidden) continue;

      const { x, y } = hexToPixel(c, r, originX, originY);
      const isHighlighted = isInCluster(c, r, hoverCluster);
      const isSelected = isInCluster(c, r, selectedCluster);

      const oScale = override ? (override.scale ?? 1) : 1;
      const oAlpha = override ? (override.alpha ?? 1) : 1;
      const oOffX  = override ? (override.offsetX ?? 0) : 0;
      const oOffY  = override ? (override.offsetY ?? 0) : 0;

      let baseScale = 1;
      if (isSelected) baseScale = 1.05;
      const drawSize = (HEX_SIZE - 1) * baseScale * oScale;

      drawHex(x + oOffX, y + oOffY, drawSize, cell.colorIndex, oAlpha);

      // Special piece indicator
      if (cell.special) {
        drawSpecialIndicator(x + oOffX, y + oOffY, drawSize * 0.5, cell.special, oAlpha, cell.bombTimer);
      }

      // Shadow under scaled-up pieces
      if (oScale > 1.05) {
        ctx.save();
        ctx.globalAlpha = 0.25;
        const corners = hexCorners(x + oOffX + 3, y + oOffY + 3, drawSize);
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
        ctx.closePath();
        ctx.fillStyle = '#000';
        ctx.fill();
        ctx.restore();
      }

      if (isSelected && !override) {
        drawHexOutline(x, y, (HEX_SIZE - 1) * 1.05 + 1, '#FFFFFF', 2.5);
      } else if (isHighlighted && !selectedCluster) {
        drawHexOutline(x, y, HEX_SIZE, CLUSTER_HIGHLIGHT, 2);
      }
    }
  }

  // Selection centroid indicator
  const indicatorCluster = selectedCluster || (hoverCluster && !selectedCluster ? hoverCluster : null);
  if (indicatorCluster && indicatorCluster.length > 0) {
    const positions = indicatorCluster.map(h => hexToPixel(h.col, h.row, originX, originY));
    const cx = positions.reduce((s, p) => s + p.x, 0) / positions.length;
    const cy = positions.reduce((s, p) => s + p.y, 0) / positions.length;
    ctx.save();
    // Glow
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = selectedCluster ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 200, 0.35)';
    ctx.fill();
    // Dot
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = selectedCluster ? '#FFFFFF' : 'rgba(255, 255, 200, 0.7)';
    ctx.fill();
    ctx.restore();
  }

  // Floating pieces (on top of everything)
  for (const fp of floatingPieces) {
    if (fp.shadow) {
      ctx.save();
      ctx.globalAlpha = 0.3;
      const sCorners = hexCorners(fp.x + 3, fp.y + 3, (HEX_SIZE - 1) * (fp.scale ?? 1));
      ctx.beginPath();
      ctx.moveTo(sCorners[0].x, sCorners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(sCorners[i].x, sCorners[i].y);
      ctx.closePath();
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.restore();
    }
    const fpSize = (HEX_SIZE - 1) * (fp.scale ?? 1);
    drawHex(fp.x, fp.y, fpSize, fp.colorIndex, fp.alpha ?? 1);
    if (fp.special) {
      drawSpecialIndicator(fp.x, fp.y, fpSize * 0.5, fp.special, fp.alpha ?? 1, fp.bombTimer);
    }
  }

  // HUD
  drawHUD();
}

// ─── Hex drawing ────────────────────────────────────────────────

function drawHex(cx, cy, size, colorIndex, alpha = 1) {
  const color = colorIndex === -1 ? STARFLOWER_COLOR : PIECE_COLORS[colorIndex];
  if (!color) return;

  const corners = hexCorners(cx, cy, size);

  ctx.save();
  ctx.globalAlpha = alpha;

  // Path
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();

  // Radial gradient: lighter center → darker edge (dome/bevel effect)
  const grad = ctx.createRadialGradient(cx - size * 0.2, cy - size * 0.2, size * 0.1,
                                         cx, cy, size);
  grad.addColorStop(0, color.light);
  grad.addColorStop(0.6, color.base);
  grad.addColorStop(1, color.dark);
  ctx.fillStyle = grad;
  ctx.fill();

  // Glossy highlight (top-left arc)
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  ctx.lineTo(corners[5].x, corners[5].y);
  ctx.lineTo(corners[4].x, corners[4].y);
  ctx.lineTo(cx, cy);
  ctx.closePath();
  const highlightGrad = ctx.createLinearGradient(
    corners[5].x, corners[5].y, cx, cy);
  highlightGrad.addColorStop(0, 'rgba(255,255,255,0.35)');
  highlightGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = highlightGrad;
  ctx.fill();

  // Outline
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.strokeStyle = color.dark;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

function drawSpecialIndicator(cx, cy, radius, type, alpha = 1, bombTimer) {
  ctx.save();
  ctx.globalAlpha = alpha * 0.9;

  switch (type) {
    case 'starflower': {
      // 6 petals
      const petalR = radius * 0.4;
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i;
        const px = cx + Math.cos(angle) * radius * 0.5;
        const py = cy + Math.sin(angle) * radius * 0.5;
        ctx.beginPath();
        ctx.ellipse(px, py, petalR, petalR * 0.6,
                    angle, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 200, 255, 0.8)';
        ctx.fill();
      }
      // Center dot
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 150, 0.9)';
      ctx.fill();
      break;
    }
    case 'bomb': {
      // Dark circle background
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.7, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(20, 20, 20, 0.75)';
      ctx.fill();

      // Pulsing red ring when timer is low
      if (bombTimer !== undefined && bombTimer <= 5) {
        ctx.strokeStyle = `rgba(255, 50, 50, ${0.5 + 0.5 * Math.sin(Date.now() / 150)})`;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(255, 100, 50, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Timer number
      if (bombTimer !== undefined) {
        ctx.fillStyle = bombTimer <= 5 ? '#FF4040' : '#FFFFFF';
        ctx.font = `bold ${radius * 0.9}px "Segoe UI", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(bombTimer), cx, cy + 1);
      }
      break;
    }
  }

  ctx.restore();
}

function drawHexOutline(cx, cy, size, strokeColor, lineWidth) {
  const corners = hexCorners(cx, cy, size);
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

// ─── Board background ───────────────────────────────────────────

function drawBoardBackground() {
  const padding = HEX_SIZE * 1.2;
  const gridPixelW = (GRID_COLS - 1) * HEX_SIZE * 1.5 + HEX_SIZE * 2;
  const gridPixelH = GRID_ROWS * Math.sqrt(3) * HEX_SIZE + Math.sqrt(3) / 2 * HEX_SIZE;
  const x = originX - HEX_SIZE - padding / 2;
  const y = originY - Math.sqrt(3) / 2 * HEX_SIZE - padding / 2;
  const w = gridPixelW + padding;
  const h = gridPixelH + padding;

  ctx.fillStyle = BOARD_BG_COLOR;
  roundRect(ctx, x, y, w, h, 12);
  ctx.fill();

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 12);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ─── HUD ────────────────────────────────────────────────────────

function drawHUD() {
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = 'bold 22px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('HEXIC', 16, 28);

  ctx.textAlign = 'right';
  ctx.font = 'bold 20px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(`SCORE  ${getDisplayScore()}`, canvasW - 16, 28);

  const combo = getComboCount();
  if (combo > 1) {
    ctx.fillStyle = '#FFD740';
    ctx.font = 'bold 16px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`COMBO x${combo}`, canvasW / 2, 28);
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function isInCluster(col, row, cluster) {
  if (!cluster) return false;
  return cluster.some(h => h.col === col && h.row === row);
}
