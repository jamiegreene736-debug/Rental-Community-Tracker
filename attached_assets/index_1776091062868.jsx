/**
 * GuestyListingBuilder — Main UI component
 *
 * Replaces the Lodgify browser-automation workflow entirely.
 * Provides:
 *   • Guesty connection status indicator
 *   • Airbnb / Booking.com / VRBO channel live-status columns
 *   • Full data stream view (photos, amenities, descriptions, pricing)
 *   • Build new listing + update existing listing via Guesty API
 *
 * Usage:
 *   <GuestyListingBuilder propertyData={scrapedData} />
 *
 *   propertyData is the structured output from your scraper agent.
 *   If null, the component works in "select existing" mode only.
 */

import { useState, useEffect, useCallback } from 'react';
import { guestyService } from '../../services/guestyService';

// ─── Fonts (injected into <head> once) ───────────────────────────────────────
const FONT_LINK_ID = 'guesty-builder-fonts';
if (typeof document !== 'undefined' && !document.getElementById(FONT_LINK_ID)) {
  const link = document.createElement('link');
  link.id = FONT_LINK_ID;
  link.rel = 'stylesheet';
  link.href =
    'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&family=Inter:wght@300;400;500&display=swap';
  document.head.appendChild(link);
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = `
  .glb-root {
    --bg: #0A0C10;
    --bg-card: #111318;
    --bg-hover: #161A22;
    --border: #1E2330;
    --border-bright: #2A3045;
    --green: #00E676;
    --green-dim: #00E67620;
    --green-glow: 0 0 12px #00E67640;
    --red: #FF3B5C;
    --red-dim: #FF3B5C20;
    --amber: #FFB300;
    --amber-dim: #FFB30020;
    --blue: #448AFF;
    --blue-dim: #448AFF18;
    --text-primary: #F0F2F8;
    --text-secondary: #7B8299;
    --text-muted: #454D66;
    --font-display: 'Syne', sans-serif;
    --font-mono: 'JetBrains Mono', monospace;
    --font-body: 'Inter', sans-serif;
    --radius: 10px;
    --radius-sm: 6px;
    font-family: var(--font-body);
    background: var(--bg);
    color: var(--text-primary);
    min-height: 100vh;
    padding: 24px;
    box-sizing: border-box;
  }

  /* ── Header ── */
  .glb-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 28px;
    flex-wrap: wrap;
    gap: 16px;
  }

  .glb-title-block h1 {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -0.5px;
    margin: 0 0 4px 0;
    color: var(--text-primary);
  }

  .glb-title-block p {
    font-size: 12px;
    color: var(--text-muted);
    margin: 0;
    font-family: var(--font-mono);
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }

  .glb-connection-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 14px;
    border-radius: 100px;
    font-size: 12px;
    font-family: var(--font-mono);
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    border: 1px solid transparent;
    user-select: none;
  }

  .glb-connection-pill.connected {
    background: var(--green-dim);
    border-color: #00E67640;
    color: var(--green);
  }

  .glb-connection-pill.disconnected {
    background: var(--red-dim);
    border-color: #FF3B5C40;
    color: var(--red);
  }

  .glb-connection-pill.checking {
    background: var(--amber-dim);
    border-color: #FFB30040;
    color: var(--amber);
  }

  .glb-pulse {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
  }

  .glb-connection-pill.connected .glb-pulse {
    animation: glb-pulse 2s ease-in-out infinite;
  }

  @keyframes glb-pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 #00E67660; }
    50% { opacity: 0.8; box-shadow: 0 0 0 4px #00E67600; }
  }

  /* ── Listing Selector Row ── */
  .glb-selector-row {
    display: flex;
    gap: 10px;
    margin-bottom: 24px;
    align-items: center;
    flex-wrap: wrap;
  }

  .glb-select {
    background: var(--bg-card);
    border: 1px solid var(--border);
    color: var(--text-primary);
    padding: 9px 14px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-family: var(--font-body);
    flex: 1;
    min-width: 200px;
    max-width: 380px;
    cursor: pointer;
    outline: none;
    transition: border-color 0.2s;
  }

  .glb-select:focus { border-color: var(--border-bright); }

  .glb-btn {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 16px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-family: var(--font-mono);
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.18s;
    white-space: nowrap;
    letter-spacing: 0.3px;
  }

  .glb-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .glb-btn-primary {
    background: var(--green);
    color: #000;
    border-color: var(--green);
  }

  .glb-btn-primary:not(:disabled):hover {
    background: #33EE8A;
    box-shadow: var(--green-glow);
  }

  .glb-btn-secondary {
    background: transparent;
    color: var(--text-secondary);
    border-color: var(--border);
  }

  .glb-btn-secondary:not(:disabled):hover {
    border-color: var(--border-bright);
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  .glb-btn-danger {
    background: transparent;
    color: var(--red);
    border-color: #FF3B5C40;
  }

  .glb-btn-danger:not(:disabled):hover {
    background: var(--red-dim);
  }

  /* ── Channel Grid ── */
  .glb-channel-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-bottom: 24px;
  }

  @media (max-width: 700px) {
    .glb-channel-grid { grid-template-columns: 1fr; }
  }

  .glb-channel-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px;
    transition: border-color 0.2s;
  }

  .glb-channel-card.live { border-color: #00E67630; }
  .glb-channel-card.dead { border-color: #FF3B5C20; }
  .glb-channel-card.disconnected { border-color: var(--border); }

  .glb-channel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }

  .glb-channel-name {
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .glb-channel-icon {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    flex-shrink: 0;
  }

  .glb-status-badge {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border-radius: 100px;
    font-size: 11px;
    font-family: var(--font-mono);
    font-weight: 500;
    border: 1px solid transparent;
  }

  .glb-status-badge.live {
    background: var(--green-dim);
    border-color: #00E67640;
    color: var(--green);
  }

  .glb-status-badge.not-live {
    background: var(--red-dim);
    border-color: #FF3B5C40;
    color: var(--red);
  }

  .glb-status-badge.pending {
    background: var(--amber-dim);
    border-color: #FFB30040;
    color: var(--amber);
  }

  .glb-status-badge.no-account {
    background: transparent;
    border-color: var(--border);
    color: var(--text-muted);
  }

  .glb-status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
  }

  .glb-channel-meta {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    margin-top: 8px;
    word-break: break-all;
  }

  /* ── Data Stream Panel ── */
  .glb-data-panel {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .glb-tab-bar {
    display: flex;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .glb-tab-bar::-webkit-scrollbar { display: none; }

  .glb-tab {
    padding: 13px 18px;
    font-size: 12px;
    font-family: var(--font-mono);
    font-weight: 500;
    cursor: pointer;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    transition: all 0.15s;
    white-space: nowrap;
    background: none;
    border-top: none;
    border-left: none;
    border-right: none;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    margin-bottom: -1px;
  }

  .glb-tab:hover { color: var(--text-secondary); }

  .glb-tab.active {
    color: var(--green);
    border-bottom-color: var(--green);
  }

  .glb-tab-content {
    padding: 20px;
    min-height: 240px;
  }

  /* ── Photos Tab ── */
  .glb-photos-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 8px;
  }

  .glb-photo-thumb {
    aspect-ratio: 4/3;
    border-radius: var(--radius-sm);
    overflow: hidden;
    position: relative;
    background: var(--bg-hover);
    border: 1px solid var(--border);
  }

  .glb-photo-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .glb-photo-index {
    position: absolute;
    top: 5px;
    left: 5px;
    background: #000000AA;
    color: #fff;
    font-size: 10px;
    font-family: var(--font-mono);
    padding: 2px 6px;
    border-radius: 3px;
  }

  /* ── Amenities Tab ── */
  .glb-amenities-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 6px;
  }

  .glb-amenity-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-secondary);
  }

  .glb-amenity-check {
    color: var(--green);
    font-size: 11px;
    flex-shrink: 0;
  }

  /* ── Description Tab ── */
  .glb-desc-block {
    margin-bottom: 18px;
  }

  .glb-desc-label {
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 6px;
  }

  .glb-desc-text {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.6;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 14px;
  }

  /* ── Pricing Tab ── */
  .glb-pricing-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 10px;
  }

  .glb-pricing-card {
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 14px;
  }

  .glb-pricing-label {
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 6px;
  }

  .glb-pricing-value {
    font-size: 20px;
    font-family: var(--font-display);
    font-weight: 700;
    color: var(--text-primary);
  }

  .glb-pricing-currency {
    font-size: 12px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    margin-left: 3px;
  }

  /* ── Build Log ── */
  .glb-log {
    margin-top: 20px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .glb-log-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .glb-log-body {
    padding: 12px 16px;
    max-height: 220px;
    overflow-y: auto;
  }

  .glb-log-entry {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 5px 0;
    font-size: 12px;
    font-family: var(--font-mono);
    border-bottom: 1px solid var(--border);
  }

  .glb-log-entry:last-child { border-bottom: none; }

  .glb-log-step {
    color: var(--text-muted);
    width: 160px;
    flex-shrink: 0;
  }

  .glb-log-status-success { color: var(--green); }
  .glb-log-status-error { color: var(--red); }
  .glb-log-status-pending { color: var(--amber); }

  .glb-log-detail {
    color: var(--text-secondary);
    flex: 1;
  }

  /* ── Empty State ── */
  .glb-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
    text-align: center;
    gap: 10px;
  }

  .glb-empty-icon {
    font-size: 36px;
    opacity: 0.3;
    margin-bottom: 4px;
  }

  .glb-empty-title {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .glb-empty-sub {
    font-size: 12px;
    color: var(--text-muted);
    max-width: 280px;
  }

  /* ── Spinner ── */
  .glb-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid #ffffff30;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: glb-spin 0.7s linear infinite;
  }

  @keyframes glb-spin {
    to { transform: rotate(360deg); }
  }

  /* ── Divider ── */
  .glb-divider {
    height: 1px;
    background: var(--border);
    margin: 20px 0;
  }

  /* ── Action Row ── */
  .glb-action-row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 24px;
    align-items: center;
  }

  .glb-action-spacer { flex: 1; }

  /* ── Section Label ── */
  .glb-section-label {
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 12px;
  }

  /* ── Progress Bar ── */
  .glb-progress-wrap {
    height: 3px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 4px;
  }

  .glb-progress-bar {
    height: 100%;
    background: var(--green);
    border-radius: 2px;
    transition: width 0.4s ease;
  }

  /* ── Toast ── */
  .glb-toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: var(--bg-card);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    padding: 12px 18px;
    font-size: 13px;
    font-family: var(--font-body);
    color: var(--text-primary);
    z-index: 9999;
    display: flex;
    align-items: center;
    gap: 10px;
    box-shadow: 0 8px 32px #00000080;
    animation: glb-slide-up 0.25s ease;
  }

  @keyframes glb-slide-up {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .glb-toast.success { border-color: #00E67640; }
  .glb-toast.error { border-color: #FF3B5C40; }
`;

// ─── Inject Styles ────────────────────────────────────────────────────────────
const STYLE_ID = 'guesty-builder-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = styles;
  document.head.appendChild(el);
}

// ─── Channel Config ───────────────────────────────────────────────────────────
const CHANNELS = [
  { key: 'airbnb', label: 'Airbnb', icon: '🏠', color: '#FF5A5F' },
  { key: 'bookingCom', label: 'Booking.com', icon: '🔵', color: '#003580' },
  { key: 'vrbo', label: 'VRBO', icon: '🏖️', color: '#1C4F8C' },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function ConnectionPill({ status, onRefresh }) {
  const map = {
    connected: { label: 'Guesty Connected', cls: 'connected' },
    disconnected: { label: 'Not Connected', cls: 'disconnected' },
    checking: { label: 'Checking...', cls: 'checking' },
  };
  const { label, cls } = map[status] || map.checking;

  return (
    <button className={`glb-connection-pill ${cls}`} onClick={onRefresh} title="Click to refresh">
      <span className="glb-pulse" />
      {status === 'checking' ? <span className="glb-spinner" /> : null}
      {label}
      <span style={{ opacity: 0.5, fontSize: 10 }}>↻</span>
    </button>
  );
}

function ChannelCard({ channel, status }) {
  const cardClass = !status
    ? 'disconnected'
    : status.live
    ? 'live'
    : status.connected
    ? 'dead'
    : 'disconnected';

  const badgeInfo = !status
    ? { cls: 'no-account', label: 'No Account' }
    : status.live
    ? { cls: 'live', label: 'LIVE' }
    : status.connected
    ? { cls: 'not-live', label: 'Not Live' }
    : { cls: 'no-account', label: 'Not Connected' };

  return (
    <div className={`glb-channel-card ${cardClass}`}>
      <div className="glb-channel-header">
        <div className="glb-channel-name">
          <div
            className="glb-channel-icon"
            style={{ background: channel.color + '22', border: `1px solid ${channel.color}44` }}
          >
            {channel.icon}
          </div>
          {channel.label}
        </div>
        <div className={`glb-status-badge ${badgeInfo.cls}`}>
          <span className="glb-status-dot" />
          {badgeInfo.label}
        </div>
      </div>
      {status?.id && (
        <div className="glb-channel-meta">
          ID: {status.id}
        </div>
      )}
      {!status?.connected && (
        <div className="glb-channel-meta" style={{ color: 'var(--text-muted)' }}>
          Connect in Guesty dashboard to activate
        </div>
      )}
    </div>
  );
}

function PhotosTab({ photos }) {
  if (!photos?.length) {
    return (
      <div className="glb-empty">
        <div className="glb-empty-icon">📷</div>
        <div className="glb-empty-title">No photos loaded</div>
        <div className="glb-empty-sub">Photos from your scraper will appear here before building</div>
      </div>
    );
  }
  return (
    <div>
      <div className="glb-section-label">{photos.length} photos queued</div>
      <div className="glb-photos-grid">
        {photos.map((p, i) => (
          <div key={i} className="glb-photo-thumb">
            <img src={typeof p === 'string' ? p : p.url} alt={`Photo ${i + 1}`} />
            <span className="glb-photo-index">{i + 1}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AmenitiesTab({ amenities }) {
  if (!amenities?.length) {
    return (
      <div className="glb-empty">
        <div className="glb-empty-icon">✨</div>
        <div className="glb-empty-title">No amenities loaded</div>
        <div className="glb-empty-sub">Amenities from your scraper will appear here</div>
      </div>
    );
  }
  return (
    <div>
      <div className="glb-section-label">{amenities.length} amenities</div>
      <div className="glb-amenities-grid">
        {amenities.map((a, i) => (
          <div key={i} className="glb-amenity-item">
            <span className="glb-amenity-check">✓</span>
            <span>{typeof a === 'string' ? a.replace(/_/g, ' ') : a.name || a}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DescriptionsTab({ descriptions }) {
  if (!descriptions) {
    return (
      <div className="glb-empty">
        <div className="glb-empty-icon">📝</div>
        <div className="glb-empty-title">No descriptions loaded</div>
        <div className="glb-empty-sub">Descriptions from your scraper will appear here</div>
      </div>
    );
  }
  const fields = [
    { key: 'title', label: 'Title' },
    { key: 'summary', label: 'Summary' },
    { key: 'space', label: 'The Space' },
    { key: 'neighborhood', label: 'Neighborhood' },
    { key: 'transit', label: 'Getting Around' },
    { key: 'access', label: 'Guest Access' },
    { key: 'notes', label: 'Other Notes' },
    { key: 'houseRules', label: 'House Rules' },
  ];
  return (
    <div>
      {fields.map(
        ({ key, label }) =>
          descriptions[key] && (
            <div key={key} className="glb-desc-block">
              <div className="glb-desc-label">{label}</div>
              <div className="glb-desc-text">{descriptions[key]}</div>
            </div>
          )
      )}
    </div>
  );
}

function PricingTab({ pricing }) {
  if (!pricing) {
    return (
      <div className="glb-empty">
        <div className="glb-empty-icon">💰</div>
        <div className="glb-empty-title">No pricing loaded</div>
        <div className="glb-empty-sub">Rates from your scraper will appear here</div>
      </div>
    );
  }
  const cur = pricing.currency || 'USD';
  const fmt = (val) =>
    val != null ? (
      <>
        {val.toLocaleString()}
        <span className="glb-pricing-currency">{cur}</span>
      </>
    ) : (
      <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>—</span>
    );

  const cards = [
    { label: 'Base / Night', value: pricing.basePrice },
    { label: 'Weekend / Night', value: pricing.weekendBasePrice },
    { label: 'Cleaning Fee', value: pricing.cleaningFee },
    { label: 'Security Deposit', value: pricing.securityDeposit },
    { label: 'Extra Person', value: pricing.extraPersonFee },
  ];

  const discounts = [
    pricing.weeklyDiscount && {
      label: 'Weekly Discount',
      value: `${Math.round((1 - pricing.weeklyDiscount) * 100)}%`,
    },
    pricing.monthlyDiscount && {
      label: 'Monthly Discount',
      value: `${Math.round((1 - pricing.monthlyDiscount) * 100)}%`,
    },
  ].filter(Boolean);

  return (
    <div>
      <div className="glb-section-label">Base Rates</div>
      <div className="glb-pricing-grid">
        {cards.map(({ label, value }) => (
          <div key={label} className="glb-pricing-card">
            <div className="glb-pricing-label">{label}</div>
            <div className="glb-pricing-value">{fmt(value)}</div>
          </div>
        ))}
        {discounts.map(({ label, value }) => (
          <div key={label} className="glb-pricing-card" style={{ borderColor: 'var(--green-dim)' }}>
            <div className="glb-pricing-label">{label}</div>
            <div className="glb-pricing-value" style={{ color: 'var(--green)' }}>
              {value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BuildLog({ entries }) {
  if (!entries?.length) return null;

  const total = entries.length;
  const done = entries.filter((e) => e.status !== 'pending').length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="glb-log">
      <div className="glb-log-header">
        <span>Build Log</span>
        <span>{pct}% complete</span>
      </div>
      <div className="glb-progress-wrap">
        <div className="glb-progress-bar" style={{ width: `${pct}%` }} />
      </div>
      <div className="glb-log-body">
        {entries.map((e, i) => (
          <div key={i} className="glb-log-entry">
            <span className="glb-log-step">{e.step.replace(/_/g, ' ')}</span>
            <span className={`glb-log-status-${e.status}`}>
              {e.status === 'pending' ? '…' : e.status === 'success' ? '✓' : '✗'}
            </span>
            <span className="glb-log-detail">
              {e.error || e.id || (e.count != null ? `${e.count} items` : '') || ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {object|null} props.propertyData - Scraped property data from your agent
 * @param {string|null} props.existingListingId - Pre-select a listing ID
 * @param {function} props.onBuildComplete - Callback: ({ listingId, steps, errors }) => void
 * @param {function} props.onUpdateComplete - Callback: ({ listingId, steps, errors }) => void
 */
export default function GuestyListingBuilder({
  propertyData = null,
  existingListingId = null,
  onBuildComplete = () => {},
  onUpdateComplete = () => {},
}) {
  const [connectionStatus, setConnectionStatus] = useState('checking');
  const [listings, setListings] = useState([]);
  const [selectedId, setSelectedId] = useState(existingListingId || '');
  const [selectedListing, setSelectedListing] = useState(null);
  const [channelStatus, setChannelStatus] = useState(null);
  const [activeTab, setActiveTab] = useState('photos');
  const [buildLog, setBuildLog] = useState([]);
  const [isBuildingNew, setIsBuildingNew] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isLoadingListing, setIsLoadingListing] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  // ── Check Guesty connection ───────────────────────────────────────────────
  const checkConnection = useCallback(async () => {
    setConnectionStatus('checking');
    const result = await guestyService.checkConnection();
    setConnectionStatus(result.connected ? 'connected' : 'disconnected');
    if (result.connected) {
      try {
        const data = await guestyService.getListings(50);
        setListings(data?.results || []);
      } catch (e) {
        console.error('Failed to load listings', e);
      }
    }
  }, []);

  useEffect(() => { checkConnection(); }, [checkConnection]);

  // ── Load listing details when selected ───────────────────────────────────
  useEffect(() => {
    if (!selectedId) {
      setSelectedListing(null);
      setChannelStatus(null);
      return;
    }
    (async () => {
      setIsLoadingListing(true);
      try {
        const [listing, channels] = await Promise.all([
          guestyService.getListing(selectedId),
          guestyService.getChannelStatus(selectedId),
        ]);
        setSelectedListing(listing);
        setChannelStatus(channels);
      } catch (e) {
        showToast(`Failed to load listing: ${e.message}`, 'error');
      } finally {
        setIsLoadingListing(false);
      }
    })();
  }, [selectedId, showToast]);

  // ── Data source: prefer selectedListing for existing, propertyData for new ──
  const displayData = propertyData || selectedListing;
  const photos =
    propertyData?.photos ||
    selectedListing?.pictures?.map((p) => ({ url: p.original, caption: p.caption })) ||
    [];
  const amenities = propertyData?.amenities || selectedListing?.amenities || [];
  const descriptions = propertyData?.descriptions || {
    title: selectedListing?.title,
    summary: selectedListing?.publicDescriptions?.summary,
    space: selectedListing?.publicDescriptions?.space,
    neighborhood: selectedListing?.publicDescriptions?.neighborhood,
    transit: selectedListing?.publicDescriptions?.transit,
    access: selectedListing?.publicDescriptions?.access,
    notes: selectedListing?.publicDescriptions?.notes,
  };
  const pricing = propertyData?.pricing
    ? propertyData.pricing
    : selectedListing?.prices
    ? {
        basePrice: selectedListing.prices.basePrice,
        weekendBasePrice: selectedListing.prices.weekendBasePrice,
        cleaningFee: selectedListing.prices.cleaningFee,
        securityDeposit: selectedListing.prices.securityDepositFee,
        extraPersonFee: selectedListing.prices.extraPersonFee,
        currency: selectedListing.prices.currency,
        weeklyDiscount: selectedListing.prices.weeklyPriceFactor,
        monthlyDiscount: selectedListing.prices.monthlyPriceFactor,
      }
    : null;

  // ── Build new listing ─────────────────────────────────────────────────────
  const handleBuild = async () => {
    if (!propertyData) return;
    setIsBuildingNew(true);
    setBuildLog([]);

    const result = await guestyService.buildFullListing(propertyData, (step, status, detail) => {
      setBuildLog((prev) => {
        const existing = prev.findIndex((e) => e.step === step);
        const entry = { step, status, ...detail };
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = entry;
          return next;
        }
        return [...prev, entry];
      });
    });

    setIsBuildingNew(false);
    if (result.success) {
      showToast(`Listing built successfully! ID: ${result.listingId}`, 'success');
      // Refresh listings
      const data = await guestyService.getListings(50).catch(() => ({ results: [] }));
      setListings(data?.results || []);
      setSelectedId(result.listingId);
      onBuildComplete(result);
    } else {
      showToast(`Build completed with ${result.errors.length} error(s)`, 'error');
      onBuildComplete(result);
    }
  };

  // ── Update existing listing ───────────────────────────────────────────────
  const handleUpdate = async () => {
    if (!selectedId || !propertyData) return;
    setIsUpdating(true);
    setBuildLog([]);

    const result = await guestyService.updateFullListing(selectedId, propertyData, (step, status, detail) => {
      setBuildLog((prev) => {
        const existing = prev.findIndex((e) => e.step === step);
        const entry = { step, status, ...detail };
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = entry;
          return next;
        }
        return [...prev, entry];
      });
    });

    setIsUpdating(false);
    if (result.success) {
      showToast('Listing updated successfully!', 'success');
      // Refresh channel status
      const channels = await guestyService.getChannelStatus(selectedId).catch(() => null);
      if (channels) setChannelStatus(channels);
      onUpdateComplete(result);
    } else {
      showToast(`Update completed with ${result.errors.length} error(s)`, 'error');
      onUpdateComplete(result);
    }
  };

  // ── Toggle listing status ─────────────────────────────────────────────────
  const handleToggleLive = async () => {
    if (!selectedId || !channelStatus) return;
    const newStatus = !channelStatus.isListed;
    try {
      await guestyService.setListingStatus(selectedId, newStatus);
      setChannelStatus((prev) => ({ ...prev, isListed: newStatus }));
      showToast(newStatus ? 'Listing is now live!' : 'Listing is now unlisted', 'success');
    } catch (e) {
      showToast(`Failed to toggle status: ${e.message}`, 'error');
    }
  };

  const tabs = [
    { key: 'photos', label: `Photos${photos.length ? ` (${photos.length})` : ''}` },
    { key: 'amenities', label: `Amenities${amenities.length ? ` (${amenities.length})` : ''}` },
    { key: 'descriptions', label: 'Descriptions' },
    { key: 'pricing', label: 'Pricing' },
  ];

  const isBuilding = isBuildingNew || isUpdating;

  return (
    <div className="glb-root">
      {/* ── Header ── */}
      <div className="glb-header">
        <div className="glb-title-block">
          <h1>Build Listing On Guesty</h1>
          <p>Property Channel Manager · API-Powered</p>
        </div>
        <ConnectionPill status={connectionStatus} onRefresh={checkConnection} />
      </div>

      {/* ── Listing Selector ── */}
      <div className="glb-section-label">Select or Create Listing</div>
      <div className="glb-selector-row">
        <select
          className="glb-select"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          disabled={connectionStatus !== 'connected'}
        >
          <option value="">— Select existing listing —</option>
          {listings.map((l) => (
            <option key={l._id} value={l._id}>
              {l.nickname || l.title || l._id}
            </option>
          ))}
        </select>

        {propertyData && !selectedId && (
          <button
            className="glb-btn glb-btn-primary"
            onClick={handleBuild}
            disabled={isBuilding || connectionStatus !== 'connected'}
          >
            {isBuildingNew ? <span className="glb-spinner" /> : '＋'}
            {isBuildingNew ? 'Building...' : 'Build New Listing'}
          </button>
        )}

        {propertyData && selectedId && (
          <button
            className="glb-btn glb-btn-secondary"
            onClick={handleUpdate}
            disabled={isBuilding || connectionStatus !== 'connected'}
          >
            {isUpdating ? <span className="glb-spinner" /> : '↑'}
            {isUpdating ? 'Updating...' : 'Push Updates'}
          </button>
        )}

        {selectedId && channelStatus && (
          <button
            className={`glb-btn ${channelStatus.isListed ? 'glb-btn-danger' : 'glb-btn-primary'}`}
            onClick={handleToggleLive}
            disabled={isBuilding}
          >
            {channelStatus.isListed ? '⏸ Unlist' : '▶ Go Live'}
          </button>
        )}
      </div>

      {/* ── Channel Status Grid ── */}
      <div className="glb-section-label">Channel Status</div>
      <div className="glb-channel-grid">
        {CHANNELS.map((ch) => (
          <ChannelCard
            key={ch.key}
            channel={ch}
            status={channelStatus?.[ch.key] || null}
          />
        ))}
      </div>

      {/* ── Data Stream Panel ── */}
      <div className="glb-section-label">Data Stream</div>
      <div className="glb-data-panel">
        <div className="glb-tab-bar">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={`glb-tab ${activeTab === t.key ? 'active' : ''}`}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="glb-tab-content">
          {isLoadingListing ? (
            <div className="glb-empty">
              <span className="glb-spinner" style={{ width: 24, height: 24, borderWidth: 3 }} />
              <div className="glb-empty-sub" style={{ marginTop: 12 }}>Loading listing data...</div>
            </div>
          ) : activeTab === 'photos' ? (
            <PhotosTab photos={photos} />
          ) : activeTab === 'amenities' ? (
            <AmenitiesTab amenities={amenities} />
          ) : activeTab === 'descriptions' ? (
            <DescriptionsTab descriptions={descriptions} />
          ) : (
            <PricingTab pricing={pricing} />
          )}
        </div>
      </div>

      {/* ── Build Log ── */}
      <BuildLog entries={buildLog} />

      {/* ── Toast ── */}
      {toast && (
        <div className={`glb-toast ${toast.type}`}>
          <span>{toast.type === 'success' ? '✓' : '✗'}</span>
          {toast.message}
        </div>
      )}
    </div>
  );
}
