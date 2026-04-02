// vpn-manager.js — WireGuard VPN lifecycle manager
//
// Runs wg-quick inside the container's existing network namespace.
// No extra Linux capabilities beyond NET_ADMIN + /dev/net/tun are required,
// which means it works in Docker Desktop on Windows, macOS, and Linux.
//
// Traffic isolation:
//   wg-quick with AllowedIPs=0.0.0.0/0 routes all outbound container traffic
//   through WireGuard. The host machine's network is unaffected (the container
//   has its own isolated network namespace).
//
//   The web UI on port 3003 remains locally accessible — inbound connections
//   are not subject to outbound routing rules, so browsers can still reach the
//   app normally even while VPN is active.
//
// wireguard-go (WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go) is used as the
// WireGuard backend so no host kernel WireGuard module is required.

'use strict';

const { execFile } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

const VPN_CONFIG_DIR = '/app/vpn';
const VPN_SETTINGS_FILE = '/app/data/vpn-settings.json';
const TMP_CONF = '/tmp/wg-dlvpn.conf';

// wg-quick routes all traffic not marked with this fwmark through the tunnel.
// We use the same value to EXEMPT our web server port so the dashboard stays reachable.
const WG_FWMARK = '51820';
const SERVER_PORT = process.env.PORT || '3003';

class VpnManager {
  constructor() {
    this.activeConfig = null;
    this.tmpConfCreated = false;
    this.bytesDownloadedSinceRotate = 0;
    this.consecutiveFailures = 0;
    this.settings = {
      selectedConfig: null,
      autoRotate: { onFailureCount: 0, onGbDownloaded: 0 },
      detectionRotate: {
        retriesPerVpn: 3,    // detection attempts on each VPN before switching
        maxVpnSwitches: 0,   // how many different VPNs to try per episode (0 = off)
        selectionMode: 'sequential', // 'sequential' | 'random' | 'priority'
        priorityList: [],    // ordered config names used when selectionMode='priority'
      },
    };
    this._broadcast = null;
  }

  setBroadcast(fn) { this._broadcast = fn; }

  _emit(data) {
    if (this._broadcast) this._broadcast(data);
  }

  async loadSettings() {
    try {
      const text = await fs.readFile(VPN_SETTINGS_FILE, 'utf8');
      const saved = JSON.parse(text);
      this.settings = { ...this.settings, ...saved };
      if (saved.autoRotate) {
        this.settings.autoRotate = { ...this.settings.autoRotate, ...saved.autoRotate };
      }
      if (saved.detectionRotate) {
        this.settings.detectionRotate = { ...this.settings.detectionRotate, ...saved.detectionRotate };
      }
    } catch { /* use defaults */ }
  }

  async saveSettings() {
    await fs.mkdir(path.dirname(VPN_SETTINGS_FILE), { recursive: true });
    await fs.writeFile(VPN_SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
  }

  async listConfigs() {
    try {
      const files = await fs.readdir(VPN_CONFIG_DIR);
      return files
        .filter(f => f.endsWith('.conf'))
        .map(f => f.replace(/\.conf$/, ''))
        .sort();
    } catch {
      return [];
    }
  }

  _run(cmd, args) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd}: ${stderr.trim() || err.message}`));
        else resolve(stdout.trim());
      });
    });
  }

  async _runSafe(cmd, args) {
    try { return await this._run(cmd, args); } catch { return null; }
  }

  // Call once on server startup — cleans up any leftover wg interface from a crash
  async init() {
    await this._runSafe('wg-quick', ['down', TMP_CONF]);
    await fs.unlink(TMP_CONF).catch(() => {});
    await this.loadSettings();
    const configs = await this.listConfigs();
    console.log(`[VPN] Initialized. ${configs.length} config(s) found in ${VPN_CONFIG_DIR}`);
  }

  async activate(configName) {
    if (this.activeConfig === configName) return;
    await this.deactivate();

    const confPath = path.join(VPN_CONFIG_DIR, `${configName}.conf`);
    try { await fs.access(confPath); } catch {
      throw new Error(`WireGuard config not found: ${configName}.conf`);
    }

    // Strip lines that require host tools we don't have or don't need:
    //   DNS      — wg-quick calls resolvconf which isn't installed; Docker's
    //              built-in DNS works fine without changes
    //   PostUp/PostDown/PreUp/PreDown — arbitrary hook scripts (security)
    const raw = await fs.readFile(confPath, 'utf8');
    const sanitized = raw.split('\n')
      .filter(line => !/^\s*(DNS|Post|Pre)(Up|Down)?\s*=/i.test(line))
      .join('\n');
    await fs.writeFile(TMP_CONF, sanitized, { mode: 0o600 });
    this.tmpConfCreated = true;

    try {
      await this._run('wg-quick', ['up', TMP_CONF]);

      // Exempt the web UI port from VPN routing so the dashboard stays reachable.
      // wg-quick's rule is "route everything NOT marked WG_FWMARK through the tunnel",
      // so marking our port's outbound traffic with that value makes it bypass the
      // tunnel and use the main routing table (eth0) instead.
      await this._runSafe('iptables',  ['-t', 'mangle', '-I', 'OUTPUT', '1', '-p', 'tcp', '--sport', SERVER_PORT, '-j', 'MARK', '--set-mark', WG_FWMARK]);
      await this._runSafe('ip6tables', ['-t', 'mangle', '-I', 'OUTPUT', '1', '-p', 'tcp', '--sport', SERVER_PORT, '-j', 'MARK', '--set-mark', WG_FWMARK]);

      this.activeConfig = configName;
      this.bytesDownloadedSinceRotate = 0;
      this.consecutiveFailures = 0;

      console.log(`[VPN] Activated: ${configName}`);
      this._emit({ type: 'vpn-status', active: true, config: configName, stats: this._stats() });
    } catch (err) {
      await this.deactivate();
      throw err;
    }
  }

  async deactivate() {
    if (this.tmpConfCreated) {
      await this._runSafe('iptables',  ['-t', 'mangle', '-D', 'OUTPUT', '-p', 'tcp', '--sport', SERVER_PORT, '-j', 'MARK', '--set-mark', WG_FWMARK]);
      await this._runSafe('ip6tables', ['-t', 'mangle', '-D', 'OUTPUT', '-p', 'tcp', '--sport', SERVER_PORT, '-j', 'MARK', '--set-mark', WG_FWMARK]);
      await this._runSafe('wg-quick', ['down', TMP_CONF]);
      await fs.unlink(TMP_CONF).catch(() => {});
      this.tmpConfCreated = false;
    }

    const was = this.activeConfig;
    this.activeConfig = null;
    if (was) {
      console.log(`[VPN] Deactivated: ${was}`);
      this._emit({ type: 'vpn-status', active: false, config: null, stats: this._stats() });
    }
  }

  _stats() {
    return {
      bytesDownloaded: this.bytesDownloadedSinceRotate,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  getStatus() {
    return {
      active: !!this.activeConfig,
      config: this.activeConfig,
      settings: this.settings,
      ...this._stats(),
    };
  }

  // No exec prefix needed — wg-quick routes all container traffic through
  // the VPN in the main network namespace, so tools route via VPN automatically.
  getExecPrefix() { return []; }

  // No proxy needed for the same reason — Playwright's traffic also goes
  // through the VPN routing table automatically.
  getPlaywrightProxy() { return null; }

  // Call after each episode/file finishes to trigger auto-rotation if configured.
  async trackDownload({ bytes = 0, failed = false }) {
    if (!this.activeConfig) return;

    if (failed) {
      this.consecutiveFailures++;
    } else {
      this.consecutiveFailures = 0;
      this.bytesDownloadedSinceRotate += bytes;
    }
    this._emit({ type: 'vpn-stats', config: this.activeConfig, stats: this._stats() });

    const failThreshold = parseInt(this.settings.autoRotate.onFailureCount) || 0;
    const gbThreshold   = parseFloat(this.settings.autoRotate.onGbDownloaded) || 0;

    if (failThreshold > 0 && this.consecutiveFailures >= failThreshold) {
      console.log(`[VPN] Auto-rotating: ${this.consecutiveFailures} consecutive failures`);
      await this._rotateToNext();
    } else if (gbThreshold > 0 && this.bytesDownloadedSinceRotate >= gbThreshold * 1e9) {
      const gb = (this.bytesDownloadedSinceRotate / 1e9).toFixed(2);
      console.log(`[VPN] Auto-rotating: ${gb} GB downloaded`);
      await this._rotateToNext();
    }
  }

  // Returns the next config to try for detection-based rotation, excluding
  // any configs already tried this episode. Returns null if none are available.
  async getNextForDetection(triedConfigs = []) {
    const all = await this.listConfigs();
    const { selectionMode = 'sequential', priorityList = [] } = this.settings.detectionRotate || {};

    let candidates;
    if (selectionMode === 'priority' && priorityList.length > 0) {
      // Use the saved order, filtered to existing files and not-yet-tried ones
      candidates = priorityList.filter(c => all.includes(c) && !triedConfigs.includes(c));
    } else {
      candidates = all.filter(c => !triedConfigs.includes(c));
    }

    if (candidates.length === 0) return null;
    if (selectionMode === 'random') return candidates[Math.floor(Math.random() * candidates.length)];
    return candidates[0];
  }

  async _rotateToNext() {
    const next = await this.getNextForDetection(this.activeConfig ? [this.activeConfig] : []);
    if (!next) return;
    const from = this.activeConfig;
    try {
      await this.activate(next);
      this.settings.selectedConfig = next;
      await this.saveSettings();
      this._emit({ type: 'vpn-rotated', from, to: next });
    } catch (err) {
      console.error(`[VPN] Rotation to ${next} failed: ${err.message}`);
    }
  }
}

module.exports = new VpnManager();
