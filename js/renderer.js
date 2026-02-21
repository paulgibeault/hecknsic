/**
 * renderer.js — Draw the hex board with glossy beveled hexagons,
 * dark metallic frame, cursor highlights, and HUD.
 *
 * Supports per-cell animation overrides (scale, alpha, offsetY)
 * and free-floating animated pieces.
 */

import {
  GRID_COLS, GRID_ROWS, HEX_SIZE, PIECE_COLORS, STARFLOWER_COLOR, BLACK_PEARL_COLOR,
  FRAME_COLOR, BOARD_BG_COLOR, TEXT_COLOR,
  HIGHLIGHT_COLOR, CLUSTER_HIGHLIGHT,
} from './constants.js';
import { hexToPixel, hexCorners } from './hex-math.js';
import { getActiveGameMode, getActiveMatchMode } from './modes.js';
import { getDisplayScore, getComboCount, getChainLevel } from './score.js';
// ─── Module state ───────────────────────────────────────────────
let ctx;
let canvasW, canvasH;   // physical CSS pixel dimensions
let originX, originY;   // hex grid origin in logical (design) space
let boardScale = 1;     // scale applied to fit the board on small screens

// Per-cell animation overrides: "col,row" → { scale?, alpha?, offsetX?, offsetY?, hidden? }
let cellOverrides = {};

// Free-floating pieces drawn on top (for rotation arcs, etc.)
let floatingPieces = [];  // { x, y, colorIndex, scale, alpha }

// Creation celebration particles
let creationParticles = [];  // { x, y, vx, vy, life, maxLife, size, hue }

// ─── Combo overlay state ─────────────────────────────────────────
let comboDispCount   = 0;   // peak combo count seen this cascade
let comboDispChain   = 0;   // peak chain level seen this cascade
let comboFadeStart   = 0;   // timestamp when fade-out began (0 = not fading)
let comboRotation    = 0;   // random tilt angle, re-rolled each tier upgrade
let comboLastTier    = -1;  // last rendered tier index (for re-roll detection)
let comboTierShowTime = 0;  // timestamp when current tier first appeared (for pop-in)

// ─── Score popup state ───────────────────────────────────────────
let scorePopups = [];  // { x, y, vy, text, life, maxLife, fontSize, color }

// Label tier thresholds (by combo count)
const COMBO_THRESHOLDS = [2,  8,  12,  16,  20,  24];
const COMBO_LABELS     = ['COMBO', 'NICE!', 'SWEET!', 'AMAZING!', 'SICK!', 'HECKN SIC!'];
const COMBO_COLORS     = ['#FFD740', '#FF9800', '#FF5722', '#E040FB', '#7C4DFF', '#4FC3F7'];
const COMBO_FADE_MS    = 1200;

const logoImg = new Image();
logoImg.src = 'img/logo_header.png';

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
  recalcOrigin();
  // Include boardScale in the transform so all drawing uses logical coordinates.
  // Input coords must be divided by boardScale to convert back to logical space.
  ctx.setTransform(dpr * boardScale, 0, 0, dpr * boardScale, 0, 0);
}

function recalcOrigin() {
  const gridPixelW = (GRID_COLS - 1) * HEX_SIZE * 1.5 + HEX_SIZE * 2;
  const gridPixelH = GRID_ROWS * Math.sqrt(3) * HEX_SIZE + Math.sqrt(3) / 2 * HEX_SIZE;

  // Space reserved for HUD (top) and rotation controls (bottom).
  const HUD_H  = 60;
  
  // If we have a fine pointer (mouse/trackpad) and a wide screen, controls are hidden via CSS.
  // We can free up that vertical space for the board.
  const isDesktop = window.matchMedia('(pointer: fine) and (min-width: 1024px)').matches;
  const CTRL_H = isDesktop ? 0 : 100; // 80px buttons + 20px bottom margin

  // Calculate the scale needed to fit the board. We allow upscaling (up to 1.8x)
  // on large screens to fill the comfortable margins.
  const fitScaleX = (canvasW - 40) / gridPixelW; // 20px padding each side
  const fitScaleY = (canvasH - HUD_H - CTRL_H - 20) / gridPixelH; // 20px padding bottom
  
  boardScale = Math.min(1.8, fitScaleX, fitScaleY);

  // Logical canvas dimensions: the coordinate space all drawing uses.
  const logicalW = canvasW / boardScale;
  const logicalH = canvasH / boardScale;

  // Centre the grid horizontally. Vertically, place it in the space
  // between the HUD and the controls, then shift down by the half-hex
  // offset so col-0 row-0 isn't right at the edge.
  originX = (logicalW - gridPixelW) / 2 + HEX_SIZE;
  originY = HUD_H / boardScale
          + ((logicalH - (HUD_H / boardScale) - (CTRL_H / boardScale)) - gridPixelH) / 2
          + Math.sqrt(3) / 2 * HEX_SIZE;
}

export function getOrigin() {
  return { originX, originY };
}

/** Scale factor for converting physical CSS pixel coords → logical coords. */
export function getBoardScale() { return boardScale; }

/**
 * Returns the bounding box of the logo in logical (design) space.
 * Returns null if the logo image is not yet loaded.
 */
export function getLogoBounds() {
  if (!logoImg.complete || logoImg.naturalWidth === 0) return null;
  const s = 0.085;
  return { x: 16, y: 5, w: logoImg.width * s, h: logoImg.height * s };
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

// ─── Creation Particle API ──────────────────────────────────────

export function spawnCreationParticles(cx, cy, count = 16) {
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 / count) * i + (Math.random() - 0.5) * 0.4;
    const speed = 1.5 + Math.random() * 2.5;
    creationParticles.push({
      x: cx, y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,
      maxLife: 40 + Math.random() * 30,
      size: 2 + Math.random() * 3,
      hue: 190 + Math.random() * 40,  // cool steel-blue hues
    });
  }
}

export function clearCreationParticles() {
  creationParticles = [];
}

// ─── Main draw ──────────────────────────────────────────────────

export function drawFrame(grid, hoverCluster, selectedCluster) {
  // Clear
  ctx.fillStyle = FRAME_COLOR;
  ctx.fillRect(0, 0, canvasW / boardScale, canvasH / boardScale);

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
      if (cell.special === 'multiplier') {
        drawStarStamp(x + oOffX, y + oOffY, drawSize, oAlpha);
      } else if (cell.special) {
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
    if (fp.special === 'multiplier') {
      drawStarStamp(fp.x, fp.y, fpSize, fp.alpha ?? 1);
    } else if (fp.special) {
      drawSpecialIndicator(fp.x, fp.y, fpSize * 0.5, fp.special, fp.alpha ?? 1, fp.bombTimer);
    }
  }

  // Creation celebration particles
  updateAndDrawParticles();

  // Floating score numbers
  updateAndDrawScorePopups();

  // Combo overlay (above particles, below HUD)
  drawComboOverlay();

  // HUD
  drawHUD();
}

// ─── Hex drawing ────────────────────────────────────────────────

function drawHex(cx, cy, size, colorIndex, alpha = 1) {
  // Starflower pieces get the special metallic rendering
  if (colorIndex === -1) {
    drawStarHex(cx, cy, size, alpha);
    return;
  }
  // Black pearl pieces get the obsidian pearl rendering
  if (colorIndex === -2) {
    drawBlackPearlHex(cx, cy, size, alpha);
    return;
  }

  const color = PIECE_COLORS[colorIndex];
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

// ─── Metallic star hex ──────────────────────────────────────────

function drawStarHex(cx, cy, size, alpha = 1) {
  const color = STARFLOWER_COLOR;
  const corners = hexCorners(cx, cy, size);
  const now = Date.now();

  ctx.save();
  ctx.globalAlpha = alpha;

  // Clip to hex shape
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.save();
  ctx.clip();

  // Background: dark metallic recess
  const bgGrad = ctx.createRadialGradient(cx, cy, size * 0.2, cx, cy, size);
  bgGrad.addColorStop(0, '#2A3038');
  bgGrad.addColorStop(1, '#15181C');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(cx - size, cy - size, size * 2, size * 2);

  // 3D Faceted Star
  const innerR = size * 0.25; // center radius where points meet
  const outerR = size * 0.95; // tips of the star
  
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6; // Points at corners
    // Coordinates
    // Tip of the star point (at hex corner)
    const tipX = cx + Math.cos(angle) * outerR;
    const tipY = cy + Math.sin(angle) * outerR;

    // Base of the star point (center)
    const centerX = cx;
    const centerY = cy;

    // Valley points between stars (midway to next/prev point)
    const valleyR = size * 0.45;
    const prevValleyX = cx + Math.cos(angle - Math.PI/6) * valleyR;
    const prevValleyY = cy + Math.sin(angle - Math.PI/6) * valleyR;
    const nextValleyX = cx + Math.cos(angle + Math.PI/6) * valleyR;
    const nextValleyY = cy + Math.sin(angle + Math.PI/6) * valleyR;

    // Draw Left Facet (shadowed side usually)
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(prevValleyX, prevValleyY);
    ctx.closePath();
    ctx.fillStyle = (i % 2 === 0) ? color.base : color.dark;
    ctx.fill();

    // Draw Right Facet (highlighted side usually)
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(nextValleyX, nextValleyY);
    ctx.closePath();
    ctx.fillStyle = (i % 2 === 0) ? color.light : color.base;
    ctx.fill();

    // Highlight ridge (line from center to tip)
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1.0;
    ctx.stroke();
  }

  // Shimmer effect overlay
  const shimmer = (Math.sin(now / 300) + 1) / 2;
  const shimmerGrad = ctx.createLinearGradient(
    cx - size, cy - size, cx + size, cy + size
  );
  shimmerGrad.addColorStop(0, 'rgba(255,255,255,0)');
  shimmerGrad.addColorStop(0.5, `rgba(255,255,255,${0.25 * shimmer})`);
  shimmerGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = shimmerGrad;
  ctx.fillRect(cx - size, cy - size, size * 2, size * 2);

  // Center gem/hub
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.15, 0, Math.PI * 2);
  const gemGrad = ctx.createRadialGradient(
    cx - size * 0.05, cy - size * 0.05, 0,
    cx, cy, size * 0.15
  );
  gemGrad.addColorStop(0, '#FFFFFF');
  gemGrad.addColorStop(0.5, color.light);
  gemGrad.addColorStop(1, color.dark);
  ctx.fillStyle = gemGrad;
  ctx.fill();

  ctx.restore(); // Unclip

  // Frame stroke
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.strokeStyle = '#2A3038';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.restore();
}

// ─── Black Pearl hex ────────────────────────────────────────────

function drawBlackPearlHex(cx, cy, size, alpha = 1) {
  const color = BLACK_PEARL_COLOR;
  const corners = hexCorners(cx, cy, size);
  const now = Date.now();

  ctx.save();
  ctx.globalAlpha = alpha;

  // Clip to hex shape
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.save();
  ctx.clip();

  // Base fill: deep obsidian gradient
  const baseGrad = ctx.createRadialGradient(
    cx - size * 0.2, cy - size * 0.2, size * 0.05,
    cx, cy, size * 1.1
  );
  baseGrad.addColorStop(0, color.light);
  baseGrad.addColorStop(0.4, color.base);
  baseGrad.addColorStop(1, color.dark);
  ctx.fillStyle = baseGrad;
  ctx.fillRect(cx - size, cy - size, size * 2, size * 2);

  // Iridescent sheen: shifting purple/teal overtone
  const hueShift = (now % 5000) / 5000;
  const iriHue1 = 270 + hueShift * 60;  // purple → blue
  const iriHue2 = 160 + hueShift * 40;  // teal → green
  const iriGrad = ctx.createLinearGradient(
    cx - size, cy - size, cx + size, cy + size
  );
  iriGrad.addColorStop(0.0, `hsla(${iriHue1}, 40%, 25%, 0.3)`);
  iriGrad.addColorStop(0.5, `hsla(${iriHue2}, 35%, 20%, 0.15)`);
  iriGrad.addColorStop(1.0, `hsla(${iriHue1 + 30}, 40%, 25%, 0.25)`);
  ctx.fillStyle = iriGrad;
  ctx.fillRect(cx - size, cy - size, size * 2, size * 2);

  // Pearlescent shimmer sweep
  const shimmerPhase = (now % 4000) / 4000;
  const shimmerX = cx + size * 2.5 * (shimmerPhase - 0.5);
  const shimmerGrad = ctx.createRadialGradient(
    shimmerX, cy - size * 0.2, 0,
    shimmerX, cy - size * 0.2, size * 0.9
  );
  const shimmerAlpha = 0.08 + 0.06 * Math.sin(shimmerPhase * Math.PI * 2);
  shimmerGrad.addColorStop(0, `rgba(180,160,220,${shimmerAlpha})`);
  shimmerGrad.addColorStop(1, 'rgba(180,160,220,0)');
  ctx.fillStyle = shimmerGrad;
  ctx.fillRect(cx - size, cy - size, size * 2, size * 2);

  // Specular highlight top-left
  const specGrad = ctx.createRadialGradient(
    cx - size * 0.3, cy - size * 0.3, 0,
    cx - size * 0.3, cy - size * 0.3, size * 0.6
  );
  specGrad.addColorStop(0, 'rgba(200,190,220,0.3)');
  specGrad.addColorStop(0.4, 'rgba(200,190,220,0.08)');
  specGrad.addColorStop(1, 'rgba(200,190,220,0)');
  ctx.fillStyle = specGrad;
  ctx.fillRect(cx - size, cy - size, size * 2, size * 2);

  ctx.restore(); // un-clip

  // Edge strokes
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.strokeStyle = 'rgba(140,120,180,0.3)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.strokeStyle = color.dark;
  ctx.lineWidth = 1;
  ctx.stroke();

  // ── Glowing pearl orb in center ──────────────────────────
  const orbPulse = 0.8 + 0.2 * Math.sin(now / 600);
  const orbRadius = size * 0.22;

  // Outer glow
  const glowGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbRadius * 3);
  glowGrad.addColorStop(0, `rgba(180,160,220,${0.25 * orbPulse})`);
  glowGrad.addColorStop(0.5, `rgba(140,100,200,${0.1 * orbPulse})`);
  glowGrad.addColorStop(1, 'rgba(140,100,200,0)');
  ctx.fillStyle = glowGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, orbRadius * 3, 0, Math.PI * 2);
  ctx.fill();

  // Pearl sphere
  const orbGrad = ctx.createRadialGradient(
    cx - orbRadius * 0.3, cy - orbRadius * 0.3, orbRadius * 0.1,
    cx, cy, orbRadius
  );
  orbGrad.addColorStop(0, `rgba(220,210,240,${0.9 * orbPulse})`);
  orbGrad.addColorStop(0.5, `rgba(80,60,120,${0.8 * orbPulse})`);
  orbGrad.addColorStop(1, `rgba(20,10,40,${0.7 * orbPulse})`);
  ctx.fillStyle = orbGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, orbRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawSpecialIndicator(cx, cy, radius, type, alpha = 1, bombTimer) {
  // Starflower/blackpearl indicators are built into their hex renderers
  if (type === 'starflower' || type === 'blackpearl') return;

  ctx.save();
  ctx.globalAlpha = alpha * 0.9;

  switch (type) {
    case 'bomb': {
      // Dark circle background
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.85, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(20, 20, 20, 0.8)';
      ctx.fill();

      // Fuse Arc (decreases as timer goes down)
      // Max timer usually starts around 9-12? Let's assume max is around 10 for visual arc, 
      // or just make it a full circle that depletes.
      // Let's use a standard max of 10 for the full circle for now, or just proportional if we knew max.
      // Since we don't track maxBombTimer easily here, we'll just imply a visual "danger" zone.
      // Actually, let's just make it a full ring that glows.
      
      const isLow = bombTimer <= 5;
      const pulsing = 0.5 + 0.5 * Math.sin(Date.now() / 150);

      // Outer Ring / Fuse
      ctx.beginPath();
      // Draw a partial arc? Or just a full ring that changes color?
      // Let's try a "fuse" style: 
      // If timer is high (>5), yellow/orange. If low, flashing red.
      ctx.arc(cx, cy, radius * 0.85, 0, Math.PI * 2);
      ctx.strokeStyle = isLow 
        ? `rgba(255, 50, 50, ${pulsing})` 
        : 'rgba(255, 180, 50, 0.8)';
      ctx.lineWidth = 3;
      ctx.stroke();
      
      // Little "fuse spark" rotating?
      if (bombTimer > 0) {
        const angle = (Date.now() / 300) % (Math.PI * 2);
        const fuseX = cx + Math.cos(angle) * (radius * 0.85);
        const fuseY = cy + Math.sin(angle) * (radius * 0.85);
        
        ctx.beginPath();
        ctx.arc(fuseX, fuseY, 3, 0, Math.PI * 2);
        ctx.fillStyle = isLow ? '#FFF' : '#FFD700';
        ctx.fill();
      }

      // Timer number
      if (bombTimer !== undefined) {
        ctx.fillStyle = isLow ? '#FF4040' : '#FFFFFF';
        ctx.font = `bold ${radius * 1.1}px "Segoe UI", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 4;
        ctx.fillText(String(bombTimer), cx, cy + 2);
        ctx.shadowBlur = 0;
      }
      break;
    }
  }

  ctx.restore();
}

// ─── Creation Particles ─────────────────────────────────────────

function updateAndDrawParticles() {
  if (creationParticles.length === 0) return;

  for (let i = creationParticles.length - 1; i >= 0; i--) {
    const p = creationParticles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= 0.96;  // drag
    p.vy *= 0.96;
    p.life -= 1 / p.maxLife;

    if (p.life <= 0) {
      creationParticles.splice(i, 1);
      continue;
    }

    ctx.save();
    ctx.globalAlpha = p.life * 0.9;

    // Bright diamond spark
    const s = p.size * p.life;
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = `hsla(${p.hue}, 50%, 80%, 1)`;
    ctx.fillRect(-s / 2, -s / 2, s, s);

    // Glow around spark
    ctx.rotate(-Math.PI / 4);
    const glowGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 3);
    glowGrad.addColorStop(0, `hsla(${p.hue}, 60%, 85%, ${0.3 * p.life})`);
    glowGrad.addColorStop(1, `hsla(${p.hue}, 60%, 85%, 0)`);
    ctx.fillStyle = glowGrad;
    ctx.fillRect(-s * 3, -s * 3, s * 6, s * 6);

    ctx.restore();
  }
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
  
  // Ambient neon/shadow drop off the board
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 10;
  roundRect(ctx, x, y, w, h, 12);
  ctx.fill();
  ctx.restore();

  // Highlight stroke
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1.5;
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

// ─── Easing helpers ─────────────────────────────────────────────

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// ─── Score popups ────────────────────────────────────────────────

export function spawnScorePopup(x, y, points, chainLevel = 0) {
  const colors = ['#FFFFFF', '#FFD740', '#FF9800', '#FF5722', '#E040FB', '#7C4DFF'];
  scorePopups.push({
    x,
    y,
    vy: -0.9,
    text: `+${points.toLocaleString()}`,
    life: 1.0,
    maxLife: 80,
    fontSize: 15 + Math.min(chainLevel, 4) * 3,
    color: colors[Math.min(chainLevel, colors.length - 1)],
  });
}

function updateAndDrawScorePopups() {
  if (scorePopups.length === 0) return;
  for (let i = scorePopups.length - 1; i >= 0; i--) {
    const p = scorePopups[i];
    p.y  += p.vy;
    p.vy *= 0.97;
    p.life -= 1 / p.maxLife;
    if (p.life <= 0) { scorePopups.splice(i, 1); continue; }

    const t      = 1 - p.life;
    const popIn  = t < 0.12 ? easeOutBack(t / 0.12) : 1;
    const fadeA  = p.life < 0.35 ? p.life / 0.35 : 1;

    ctx.save();
    ctx.globalAlpha  = fadeA * 0.92;
    ctx.font         = `bold ${p.fontSize * popIn}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor  = p.color;
    ctx.shadowBlur   = 8;
    ctx.fillStyle    = p.color;
    ctx.fillText(p.text, p.x, p.y);
    ctx.restore();
  }
}

// ─── Combo overlay ──────────────────────────────────────────────

function comboTierIdx(count) {
  for (let i = COMBO_THRESHOLDS.length - 1; i >= 0; i--) {
    if (count >= COMBO_THRESHOLDS[i]) return i;
  }
  return 0;
}

function drawComboOverlay() {
  const combo = getComboCount();
  const chain = getChainLevel();
  const now   = Date.now();

  if (combo > 0 || chain > 0) {
    // Cascade is active — track peaks and cancel any fade-out
    if (combo > comboDispCount) comboDispCount = combo;
    if (chain > comboDispChain) comboDispChain = chain;
    comboFadeStart = 0;

    // Re-roll rotation and restart pop-in whenever the label tier upgrades
    const tier = comboTierIdx(comboDispCount);
    if (tier !== comboLastTier) {
      comboLastTier    = tier;
      comboRotation    = (Math.random() - 0.5) * 0.32; // ±~9°
      comboTierShowTime = now;
    }
  } else if (comboDispCount > 1 && comboFadeStart === 0) {
    // Cascade just ended — begin fade-out
    comboFadeStart = now;
  }

  // Nothing to show until there's been at least 2 match events
  if (comboDispCount <= 1 && comboFadeStart === 0) return;

  // Fade alpha (1 while active, ramps to 0 over COMBO_FADE_MS after cascade ends)
  let alpha = 1;
  if (comboFadeStart > 0) {
    const elapsed = now - comboFadeStart;
    if (elapsed >= COMBO_FADE_MS) {
      comboDispCount = 0;
      comboDispChain = 0;
      comboFadeStart = 0;
      comboLastTier  = -1;
      return;
    }
    alpha = 1 - elapsed / COMBO_FADE_MS;
  }

  const tierIdx     = comboTierIdx(comboDispCount);
  const label       = COMBO_LABELS[tierIdx];
  const color       = COMBO_COLORS[tierIdx];
  // No glow at tier 0 so it doesn't visually compensate for the low alpha;
  // glow ramps up with each tier upgrade.
  const glow        = tierIdx * 9;

  // Size, position, and opacity all scale up with tier so low tiers stay unobtrusive
  const gridPixelH  = GRID_ROWS * Math.sqrt(3) * HEX_SIZE + Math.sqrt(3) / 2 * HEX_SIZE;
  const cx  = canvasW / boardScale / 2;
  // Tier 0 sits near the top of the board; higher tiers drift toward the center
  const cy  = originY + gridPixelH * (0.10 + tierIdx * 0.028);
  const baseAlpha = 0.20 + tierIdx * 0.12;  // 0.20 → 0.80 across tiers

  // Pop-in scale: grows from ~0 with overshoot over 300ms when tier first appears
  const INTRO_MS   = 300;
  const introT     = comboTierShowTime ? Math.min((now - comboTierShowTime) / INTRO_MS, 1) : 1;
  const introScale = easeOutBack(introT);

  // Font — smaller base, grows meaningfully per tier; gentle pulse on top
  const pulse       = 1 + 0.05 * Math.sin(now / 140);
  const labelFontPx = (14 + tierIdx * 11) * pulse * introScale;  // 14px → 69px
  const countFontPx = Math.max(10, labelFontPx * 0.5);

  ctx.save();
  ctx.globalAlpha  = alpha * baseAlpha;
  ctx.translate(cx, cy);
  ctx.rotate(comboRotation);
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  // Label
  ctx.shadowColor = color;
  ctx.shadowBlur  = glow;
  ctx.fillStyle   = color;
  ctx.font = `bold ${labelFontPx}px "Segoe UI", system-ui, sans-serif`;
  ctx.fillText(label, 0, -countFontPx * 0.6);

  // Count
  ctx.shadowBlur  = glow * 0.5;
  ctx.fillStyle   = '#FFFFFF';
  ctx.font = `bold ${countFontPx}px "Segoe UI", system-ui, sans-serif`;
  ctx.fillText(`x${comboDispCount}`, 0, labelFontPx * 0.45);

  ctx.restore();
}

// ─── HUD ────────────────────────────────────────────────────────

function drawHUD() {
  let textStartY = 28;

  // Logo
  if (logoImg.complete && logoImg.naturalWidth > 0) {
    const scale = 0.085;
    const w = logoImg.width * scale;
    const h = logoImg.height * scale;
    ctx.drawImage(logoImg, 16, 5, w, h);
    textStartY = 5 + h + 24; // Position text below the logo
  } else {
    // Fallback if not loaded
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = 'bold 22px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Hecknsic', 16, 28);
    textStartY = 28 + 24;
  }

  // Draw Score
  ctx.textAlign = 'left';
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = 'bold 20px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(`SCORE  ${getDisplayScore()}`, 16, textStartY);

  // Draw Mode Indicator
  ctx.fillStyle = '#50B0FF';
  ctx.font = 'bold 12px "Segoe UI", system-ui, sans-serif';
  ctx.letterSpacing = '1px';
  const gameMode = getActiveGameMode()?.label || 'ARCADE';
  const matchMode = getActiveMatchMode()?.label || 'LINE';
  ctx.fillText(`${gameMode.toUpperCase()} - ${matchMode.toUpperCase()}`, 16, textStartY + 18);
  ctx.letterSpacing = '0px'; // reset
}

// ─── Helpers ────────────────────────────────────────────────────

function isInCluster(col, row, cluster) {
  if (!cluster) return false;
  return cluster.some(h => h.col === col && h.row === row);
}

// ─── Multiplier Star Stamp ──────────────────────────────────────

function drawStarStamp(cx, cy, size, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;

  // Draw a 5-pointed star in the center
  const outerR = size * 0.4;
  const innerR = size * 0.16;
  const angleOffset = -Math.PI / 2; // Point up

  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const angle = angleOffset + (Math.PI * 2 * i) / 5;
    const x = cx + Math.cos(angle) * outerR;
    const y = cy + Math.sin(angle) * outerR;
    ctx.lineTo(x, y);

    const innerAngle = angle + Math.PI / 5;
    const ix = cx + Math.cos(innerAngle) * innerR;
    const iy = cy + Math.sin(innerAngle) * innerR;
    ctx.lineTo(ix, iy);
  }
  ctx.closePath();

  // White fill with some transparency
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.fill();

  // Slight glow
  ctx.shadowColor = '#FFFFFF';
  ctx.shadowBlur = 6;
  ctx.stroke(); // stroke to apply shadow to edge
  ctx.shadowBlur = 0;

  ctx.restore();
}
