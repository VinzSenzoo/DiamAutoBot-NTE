import blessed from "blessed";
import figlet from "figlet";
import fs from "fs";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { getAddress } from 'ethers'; 
import { execFile } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const API_BASE_URL = "https://campapi.diamante.io/api/v1";
const CONFIG_FILE = "config.json";
const ACCOUNT_DATA_FILE = "account_data.json";
const isDebug = false;
const CONFIG_DEFAULT_HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
  "Cache-Control": "no-cache",
  "Origin": "https://campaign.diamante.io",
  "Pragma": "no-cache",
  "Priority": "u=1, i",
  "Referer": "https://campaign.diamante.io/",
  "Sec-Ch-Ua": '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
};

let walletInfo = {
  address: "N/A",
  balanceDIAM: "0.00",
  activeAccount: "N/A",
  cycleCount: 0,
  nextCycle: "N/A"
};
let transactionLogs = [];
let activityRunning = false;
let isCycleRunning = false;
let shouldStop = false;
let dailyActivityInterval = null;
let addresses = [];
let proxies = [];
let recipientAddresses = [];
let selectedWalletIndex = 0;
let loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let blinkCounter = 0;
let spinnerIndex = 0;
let hasLoggedSleepInterrupt = false;
let accountTokens = {};
let isHeaderRendered = false;
let activeProcesses = 0;
let accountData = {}; 

let dailyActivityConfig = {
  sendDiamRepetitions: 1,
  minSendAmount: 0.01,
  maxSendAmount: 0.02
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const config = JSON.parse(data);
      dailyActivityConfig.sendDiamRepetitions = Number(config.sendDiamRepetitions) || 1;
      dailyActivityConfig.minSendAmount = Number(config.minSendAmount) || 0.01;
      dailyActivityConfig.maxSendAmount = Number(config.maxSendAmount) || 0.02;
      addLog(`Loaded Config Successfully`, "success");
    } else {
      addLog("No config file found, using default settings.", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}, using default settings.`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

function loadAccountData() {
  try {
    if (fs.existsSync(ACCOUNT_DATA_FILE)) {
      const data = fs.readFileSync(ACCOUNT_DATA_FILE, "utf8");
      accountData = JSON.parse(data);
      addLog(`Loaded account data from ${ACCOUNT_DATA_FILE}`, "success");
    } else {
      accountData = {};
      addLog("No account data file found, starting with empty data.", "info");
    }
  } catch (error) {
    addLog(`Failed to load account data: ${error.message}, starting with empty data.`, "error");
    accountData = {};
  }
}

function saveAccountData() {
  try {
    fs.writeFileSync(ACCOUNT_DATA_FILE, JSON.stringify(accountData, null, 2));
    addLog("Account data saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save account data: ${error.message}`, "error");
  }
}

process.on("unhandledRejection", (reason, promise) => {
  addLog(`Unhandled Rejection at: ${promise}, reason: ${reason}`, "error");
});

process.on("uncaughtException", (error) => {
  addLog(`Uncaught Exception: ${error.message}\n${error.stack}`, "error");
  process.exit(1);
});

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function addLog(message, type = "info") {
  if (type === "debug" && !isDebug) return;
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error":
      coloredMessage = `{red-fg}${message}{/red-fg}`;
      break;
    case "success":
      coloredMessage = `{green-fg}${message}{/green-fg}`;
      break;
    case "wait":
      coloredMessage = `{yellow-fg}${message}{/yellow-fg}`;
      break;
    case "debug":
      coloredMessage = `{blue-fg}${message}{/blue-fg}`;
      break;
    default:
      coloredMessage = message;
  }
  transactionLogs.push(`{bright-cyan-fg}[{/bright-cyan-fg} {bold}{grey-fg}${timestamp}{/grey-fg}{/bold} {bright-cyan-fg}]{/bright-cyan-fg} {bold}${coloredMessage}{/bold}`);
  updateLogs();
}

function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function clearTransactionLogs() {
  transactionLogs = [];
  addLog("Transaction logs cleared.", "success");
  updateLogs();
}

async function sleep(ms) {
  if (shouldStop) {
    if (!hasLoggedSleepInterrupt) {
      addLog("Process stopped successfully.", "info");
      hasLoggedSleepInterrupt = true;
    }
    return;
  }
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, ms);
      const checkStop = setInterval(() => {
        if (shouldStop) {
          clearTimeout(timeout);
          clearInterval(checkStop);
          if (!hasLoggedSleepInterrupt) {
            addLog("Process stopped successfully.", "info");
            hasLoggedSleepInterrupt = true;
          }
          resolve();
        }
      }, 100);
    });
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

function loadAddresses() {
  try {
    const data = fs.readFileSync("user.txt", "utf8");
    addresses = data.split("\n").map(addr => addr.trim()).filter(addr => addr.match(/^0x[0-9a-fA-F]{40}$/));
    addresses = addresses.map(addr => {
      try {
        const checksummed = getAddress(addr);
        addLog(`Converted address ${getShortAddress(addr)} to checksum: ${getShortAddress(checksummed)}`, "debug");
        return checksummed;
      } catch (error) {
        addLog(`Invalid address format: ${addr} - Skipping. Error: ${error.message}`, "error");
        return null;
      }
    }).filter(Boolean);

    if (addresses.length === 0) throw new Error("No valid address in user.txt");
    addLog(`Loaded ${addresses.length} address from user.txt`, "success");
  } catch (error) {
    addLog(`Failed to load addresses: ${error.message}`, "error");
    addresses = [];
  }
}

function loadProxies() {
  try {
    const data = fs.readFileSync("proxy.txt", "utf8");
    proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
    if (proxies.length === 0) throw new Error("No proxies found in proxy.txt");
    addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
  } catch (error) {
    addLog(`No proxy.txt found or failed to load, running without proxies: ${error.message}`, "warn");
    proxies = [];
  }
}

function loadRecipientAddresses() {
  try {
    const data = fs.readFileSync("wallet.txt", "utf8");
    let recipients = data.split("\n").map(addr => addr.trim()).filter(addr => addr.match(/^0x[0-9a-fA-F]{40}$/));
    recipients = recipients.map(addr => {
      try {
        return getAddress(addr);
      } catch (error) {
        addLog(`Invalid recipient address: ${addr} - Skipping.`, "error");
        return null;
      }
    }).filter(Boolean);

    if (recipients.length === 0) throw new Error("No valid addresses in wallet.txt");
    addLog(`Loaded ${recipients.length} recipient addresses from wallet.txt`, "success");
    return recipients;
  } catch (error) {
    addLog(`No wallet.txt found or failed to load, skipping DIAM transfers: ${error.message}`, "warn");
    return [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  } else {
    return new HttpsProxyAgent(proxyUrl);
  }
}

async function makeApiRequest(method, url, data, proxyUrl, customHeaders = {}, maxRetries = 3, retryDelay = 2000, useProxy = true) {
  activeProcesses++;
  let lastError = null;
  try {
    for (let attempt = 1; attempt <= maxRetries && !shouldStop; attempt++) {
      try {
        const agent = useProxy && proxyUrl ? createAgent(proxyUrl) : null;
        const headers = { ...CONFIG_DEFAULT_HEADERS, ...customHeaders };
        const config = {
          method,
          url,
          data,
          headers,
          ...(agent ? { httpsAgent: agent, httpAgent: agent } : {}),
          timeout: 15000,
          withCredentials: true,
          validateStatus: null
        };
        const response = await axios(config);

        const contentType = (response.headers && (response.headers['content-type'] || '')).toString();

        if (response.status === 403 && contentType.includes('text/html')) {
          addLog(`Request blocked by Cloudflare for ${url}`, "error");
          return response;
        }
        if (response.status >= 200 && response.status < 300) {
          return response;
        }

        lastError = new Error(`HTTP ${response.status} - ${JSON.stringify(response.data || response.statusText)}`);
        throw lastError;
      } catch (error) {
        if (error && error.response && error.response.status === 403 && ((error.response.headers['content-type'] || '').includes('text/html'))) {
          addLog(`Blocked by Cloudflare for ${url}`, "error");
          return error.response;
        }

        lastError = error;
        let errorMessage = `Attempt ${attempt}/${maxRetries} failed for API request to ${url}`;
        if (error && error.response) errorMessage += `: HTTP ${error.response.status} - ${JSON.stringify(error.response.data || error.response.statusText)}`;
        else if (error && error.request) errorMessage += `: No response received`;
        else errorMessage += `: ${error && error.message ? error.message : String(error)}`;
        addLog(errorMessage, "error");

        if (attempt < maxRetries) {
          addLog(`Retrying API request in ${retryDelay/1000} seconds.`, "wait");
          await sleep(retryDelay);
        }
      }
    }
    throw new Error(`Failed to make API request to ${url} after ${maxRetries} attempts: ${lastError && lastError.message ? lastError.message : 'unknown'}`);
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function updateWalletData() {
  const walletDataPromises = addresses.map(async (address, i) => {
    try {
      const proxyUrl = proxies[i % proxies.length] || null;
      let formattedDIAM = "N/A";
      if (accountTokens[address] && accountTokens[address].userId) {
        const balanceResponse = await getBalance(accountTokens[address].userId, proxyUrl, address);
        formattedDIAM = balanceResponse.balance.toFixed(4);
      }
      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${getShortAddress(address)}   ${formattedDIAM.padEnd(8)}`;
      if (i === selectedWalletIndex) {
        walletInfo.address = address;
        walletInfo.activeAccount = `Account ${i + 1}`;
        walletInfo.balanceDIAM = formattedDIAM;
      }
      return formattedEntry;
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return `${i === selectedWalletIndex ? "→ " : "  "}N/A 0.00`;
    }
  });
  const walletData = await Promise.all(walletDataPromises);
  addLog("Wallet data updated.", "info");
  return walletData;
}

function callCurlCffi(payload, proxy = null, impersonate = "chrome110") {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "connect.py");
    const args = [JSON.stringify(payload), proxy || "", impersonate || ""];
    execFile("python3", [script, ...args], { maxBuffer: 30 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`callCurlCffi exec error: ${err.message} ${stderr || ""}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (e) {
        return reject(new Error("Failed to parse python helper output: " + e.message + " | stdout: " + stdout));
      }
    });
  });
}

function callDiamanteAPI(url, method, payload, headers, proxy) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "api.py");
    const args = [
      url,
      method,
      payload ? JSON.stringify(payload) : "null",
      JSON.stringify(headers || {}),
      proxy || ""
    ];

    execFile("python3", [script, ...args], { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error("Invalid JSON from python helper"));
      }
    });
  });
}



async function loginAccount(address, proxyUrl, useProxy = true) {
  if (shouldStop) {
    addLog("Login stopped due to stop request.", "info");
    return false;
  }
  try {
    const loginUrl = `${API_BASE_URL}/user/connect-wallet`;
    const checksummedAddress = getAddress(address);
    addLog(`Logging in with address: ${getShortAddress(address)})`, "debug");

    let deviceId = accountData[checksummedAddress.toLowerCase()];
    if (!deviceId) {
      deviceId = `DEV${Math.random().toString(24).substr(2, 5).toUpperCase()}`;
      addLog(`Generated new deviceId for ${getShortAddress(checksummedAddress)}: ${deviceId}`, "info");
    } else {
      addLog(`Using existing deviceId for ${getShortAddress(checksummedAddress)}: ${deviceId}`, "info");
    }

    const payload = {
      address: checksummedAddress,
      deviceId: deviceId,
      deviceSource: "web_app",
      deviceType: "Windows",
      browser: "Chrome",
      ipAddress: "0.0.0.0",
      latitude: 12.9715987,
      longitude: 77.5945627,
      countryCode: "Unknown",
      country: "Unknown",
      continent: "Unknown",
      continentCode: "Unknown",
      region: "Unknown",
      regionCode: "Unknown",
      city: "Unknown"
    };
    let pyRes;
    try {
      const proxyArg = proxyUrl || "";
      pyRes = await callCurlCffi(payload, proxyArg, "chrome110");
    } catch (e) {
      addLog(`Python helper call failed: ${e.message}`, "error");
      return false;
    }

    if (pyRes.error) {
      addLog(`curl_cffi error: ${pyRes.error}`, "error");
      return false;
    }

    if (pyRes.status_code === 403 && typeof pyRes.text === "string" && pyRes.text.includes("Cloudflare")) {
      addLog(`Account ${getShortAddress(checksummedAddress)}: Blocked by Cloudflare`, "error");
      return false;
    }
    const respJson = pyRes.json;
    const respHeaders = pyRes.headers || {};
    const status = pyRes.status_code;

    if (status >= 200 && status < 300 && respJson) {
      const data = respJson.data || respJson;
      let accessToken = null;
      if (data && data.accessToken) accessToken = data.accessToken;
      if (!accessToken && respHeaders["set-cookie"]) {
        const sc = Array.isArray(respHeaders["set-cookie"]) ? respHeaders["set-cookie"][0] : respHeaders["set-cookie"];
        const match = sc && sc.match && sc.match(/access_token=([^;]+)/);
        if (match) accessToken = match[1];
      }
      if (!accessToken && data && data.user && data.user.accessToken) accessToken = data.user.accessToken;

      if (!accessToken) {
        addLog(`Account ${getShortAddress(checksummedAddress)}: Failed to extract access_token from curl_cffi response.`, "error");
        return false;
      }

      const userId = data.userId || (data.user && data.user.userId) || (respJson.data && respJson.data.userId);
      accountTokens[checksummedAddress] = { userId, accessToken };

      if (!accountData[checksummedAddress.toLowerCase()]) {
        accountData[checksummedAddress.toLowerCase()] = deviceId;
        saveAccountData();
      }

      const isSocial = (data && data.isSocialExists) || (respJson.data && respJson.data.isSocialExists);
      if (isSocial === "VERIFIED") {
        addLog(`Account ${getShortAddress(checksummedAddress)}: Login Successfully`, "success");
        await updateWallets();
        return true;
      } else if (isSocial === "INITIAL") {
        addLog(`Account ${getShortAddress(checksummedAddress)}: Not Registered Yet.`, "error");
        return false;
      } else {
        addLog(`Account ${getShortAddress(checksummedAddress)}: Unexpected state: ${isSocial}`, "error");
        return false;
      }
    } else {
      addLog(`Account ${getShortAddress(checksummedAddress)}: Login failed. status=${status}`, "error");
      return false;
    }

  } catch (error) {
    addLog(`Account ${getShortAddress(address)}: Login error: ${error && error.message ? error.message : String(error)}`, "error");
    return false;
  }
}

async function getBalance(userId, proxyUrl, address) {
  const url = `${API_BASE_URL}/transaction/get-balance/${userId}`;
  const headers = {
    "Cookie": `access_token=${accountTokens[address].accessToken}`,
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://campaign.diamante.io",
    "Referer": "https://campaign.diamante.io/"
  };

  const res = await callDiamanteAPI(url, "GET", null, headers, proxyUrl);

  if (res.status === 200 && res.json?.success) {
    return res.json.data;
  }

  throw new Error("Failed get balance");
}

async function claimFaucetForAccount(address, proxyUrl, accountIndex) {
  addLog(`Processing Claiming Faucet for account ${accountIndex + 1}`, "warn");
  const userId = accountTokens[address]?.userId;
  if (!userId) {
    addLog(`Account ${accountIndex + 1}: No userId available for faucet claim.`, "error");
    return;
  }

  const maxRetries = 8;
  const delays = [2000, 3000, 5000, 8000, 12000, 20000, 30000, 45000];

  for (let attempt = 0; attempt < maxRetries && !shouldStop; attempt++) {
    try {
      const faucetUrl = `${API_BASE_URL}/transaction/fund-wallet/${userId}`;
      const headers = {
        "Cookie": `access_token=${accountTokens[address].accessToken}`,
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://campaign.diamante.io",
        "Referer": "https://campaign.diamante.io/"
      };

      const res = await callDiamanteAPI(faucetUrl, "GET", null, headers, proxyUrl);

      if (res.status === 200 && res.json && res.json.success) {
        addLog(`Account ${accountIndex + 1}: DIAM faucet claimed successfully. Funded: ${res.json.data.fundedAmount}`, "success");
        await updateWallets();
        return;
      }

      const message = (res.json && (res.json.message || res.json.data?.message)) || (res.text || `HTTP ${res.status}`);

      if (typeof message === "string" && message.includes("You can claim from the faucet once per day")) {
        addLog(`Account ${accountIndex + 1}: ${message}`, "wait");
        return;
      }
      const retryable = (
        res.status >= 500 ||
        (res.json && (res.json.status === 429 || res.json.status === "429")) ||
        /guardians|syncing|rate limit|too many/i.test(message)
      );

      addLog(`Account ${accountIndex + 1}: Faucet attempt ${attempt + 1} returned: ${message}`, retryable ? "wait" : "error");

      if (!retryable) return;

    } catch (err) {
      addLog(`Account ${accountIndex + 1}: Faucet attempt error: ${err.message || String(err)}`, "error");
    }

    if (attempt < maxRetries - 1 && !shouldStop) {
      const d = delays[Math.min(attempt, delays.length - 1)];
      addLog(`Account ${accountIndex + 1}: Retrying faucet in ${Math.round(d/1000)}s...`, "wait");
      await sleep(d);
    }
  }

  addLog(`Account ${accountIndex + 1}: Failed to claim faucet after retries.`, "error");
}


async function getTweetContent(userId, proxyUrl, address) {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries && !shouldStop; attempt++) {
    try {
      const tweetUrl = `${API_BASE_URL}/transaction/tweet-content/${userId}`;
      const headers = {
        "Cookie": `access_token=${accountTokens[address].accessToken}`,
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://campaign.diamante.io",
        "Referer": "https://campaign.diamante.io/"
      };

      const res = await callDiamanteAPI(tweetUrl, "GET", null, headers, proxyUrl);
      if (res.status === 200 && res.json && res.json.success) {
        addLog(`Tweet Content: ${res.json.data.content}`, "debug");
        return res.json.data;
      }

      const message = res.json?.message || res.text || `HTTP ${res.status}`;
      addLog(`Tweet content attempt ${attempt+1} failed: ${message}`, "debug");

      if (attempt < maxRetries - 1) {
        await sleep(2000 + attempt * 2000);
        continue;
      }
      return null;
    } catch (err) {
      addLog(`Tweet content request error: ${err.message || String(err)}`, "error");
      if (attempt < maxRetries - 1) await sleep(3000);
    }
  }
  return null;
}


async function performSendDiam(address, proxyUrl, recipient, amount) {
  const userId = accountTokens[address]?.userId;
  if (!userId) {
    addLog(`No userId for send DIAM.`, "error");
    return false;
  }

  const sendUrl = `${API_BASE_URL}/transaction/transfer`;
  const payload = {
    toAddress: recipient,
    amount: amount,
    userId: userId
  };
  const headers = {
    "Cookie": `access_token=${accountTokens[address].accessToken}`,
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://campaign.diamante.io",
    "Referer": "https://campaign.diamante.io/"
  };

  const maxRetries = 6;
  const delays = [2000, 4000, 8000, 15000, 30000, 60000]; 

  for (let attempt = 0; attempt < maxRetries && !shouldStop; attempt++) {
    try {
      const res = await callDiamanteAPI(sendUrl, "POST", payload, headers, proxyUrl);
      if (res.status === 200 && res.json && (res.json.success === true || res.json.message === "Success")) {
        const hash = res.json.data?.transferData?.hash || res.json.data?.hash || "(no-hash)";
        addLog(`Sent ${amount} DIAM to ${getShortAddress(recipient)}. Hash: ${hash}`, "success");
        await updateWallets();
        await getTweetContent(userId, proxyUrl, address);
        return true;
      }

      const message = (res.json && (res.json.message || res.json.data?.message)) || (res.text || `HTTP ${res.status}`);
      addLog(`Send attempt ${attempt + 1} returned: ${message}`, "error");

      const retryable = (
        res.status >= 500 ||
        (res.json && (res.json.status === 429 || String(res.json.status).includes("429"))) ||
        /guardians|syncing|sync|pending|transaction pending|try again/i.test(String(message))
      );

      if (!retryable) {
        addLog(`Send Transaction Failed: ${message}`, "error");
        return false;
      }

    } catch (err) {
      addLog(`Send attempt ${attempt + 1} error: ${err.message || String(err)}`, "error");
    }
    if (attempt < maxRetries - 1 && !shouldStop) {
      const d = delays[Math.min(attempt, delays.length - 1)];
      addLog(`Send Failed , Retryin ${attempt + 1}/${maxRetries} in ${Math.round(d/1000)}s...`, "wait");
      await sleep(d);
    } else {
      addLog(`Send failed after ${maxRetries} attempts.`, "error");
      return false;
    }
  }

  return false;
}

async function runDailyActivity() {
  if (addresses.length === 0) {
    addLog("No valid addresses found.", "error");
    return;
  }
  addLog(`Starting daily activity for all accounts. Auto Send DIAM: ${dailyActivityConfig.sendDiamRepetitions}`, "info");
  activityRunning = true;
  isCycleRunning = true;
  shouldStop = false;
  hasLoggedSleepInterrupt = false;
  activeProcesses = Math.max(0, activeProcesses);
  updateMenu();
  try {
    for (let accountIndex = 0; accountIndex < addresses.length && !shouldStop; accountIndex++) {
      addLog(`Starting processing for account ${accountIndex + 1}`, "info");
      selectedWalletIndex = accountIndex;
      const proxyUrl = proxies[accountIndex % proxies.length] || null;
      addLog(`Account ${accountIndex + 1}: Using Proxy ${proxyUrl || "none"}...`, "info");
      const address = addresses[accountIndex];
      addLog(`Processing account ${accountIndex + 1}: ${getShortAddress(address)}`, "info");
      const loginResult = await loginAccount(address, proxyUrl);
      if (!loginResult) {
        addLog(`Account ${accountIndex + 1}: Skipping daily activity due to login failure.`, "error");
        continue;
      }

      if (!shouldStop) {
        const randomDelay = Math.floor(Math.random() * (12000 - 8000 + 1)) + 8000;
        addLog(`Account ${accountIndex + 1}: Waiting ${Math.floor(randomDelay / 1000)} seconds before faucet...`, "wait");
        await sleep(randomDelay);
      }

      if (!shouldStop) {
        await claimFaucetForAccount(address, proxyUrl, accountIndex);
      }

      if (!shouldStop) {
        const randomDelay = Math.floor(Math.random() * (12000 - 8000 + 1)) + 8000;
        addLog(`Account ${accountIndex + 1}: Waiting ${Math.floor(randomDelay / 1000)} seconds before next process...`, "wait");
        await sleep(randomDelay);
      }

      if (!shouldStop) {
        let successfulTransfers = 0;
        if (recipientAddresses.length > 0) {
          for (let i = 0; i < dailyActivityConfig.sendDiamRepetitions && !shouldStop; i++) {
            let recipient;
            do {
              recipient = recipientAddresses[Math.floor(Math.random() * recipientAddresses.length)];
            } while (recipient.toLowerCase() === address.toLowerCase());
            const amount = Math.random() * (dailyActivityConfig.maxSendAmount - dailyActivityConfig.minSendAmount) + dailyActivityConfig.minSendAmount;
            const amountFixed = Number(amount.toFixed(4));
            addLog(`Account ${accountIndex + 1}: Sending ${amountFixed} DIAM to ${getShortAddress(recipient)}...`, "info");
            const success = await performSendDiam(address, proxyUrl, recipient, amountFixed);
            if (success) successfulTransfers++;
            if (i < dailyActivityConfig.sendDiamRepetitions - 1 && !shouldStop) {
              const randomDelay = Math.floor(Math.random() * (30000 - 15000 + 1)) + 15000;
              addLog(`Account ${accountIndex + 1}: Waiting ${Math.floor(randomDelay / 1000)} seconds before next send...`, "wait");
              await sleep(randomDelay);
            }
          }
          addLog(`Account ${accountIndex + 1}: Completed ${successfulTransfers} successful DIAM transfers.`, "success");
        } else {
          addLog(`No recipient addresses loaded, skipping Auto Send DIAM for account ${accountIndex + 1}.`, "warn");
        }
      }

      if (accountIndex < addresses.length - 1 && !shouldStop) {
        addLog(`Waiting 60 seconds before next account...`, "wait");
        await sleep(60000);
      }
    }
    if (!shouldStop && activeProcesses <= 0) {
      addLog("All accounts processed. Waiting 24 hours for next cycle.", "success");
      dailyActivityInterval = setTimeout(runDailyActivity, 24 * 60 * 60 * 1000);
    }
  } catch (error) {
    addLog(`Daily activity failed: ${error.message}`, "error");
  } finally {
    if (shouldStop) {
      const stopCheckInterval = setInterval(() => {
        if (activeProcesses <= 0) {
          clearInterval(stopCheckInterval);
          activityRunning = false;
          isCycleRunning = false;
          shouldStop = false;
          hasLoggedSleepInterrupt = false;
          activeProcesses = 0;
          addLog(`Daily activity stopped successfully.`, "success");
          updateMenu();
          updateStatus();
          safeRender();
        } else {
          addLog(`Waiting for ${activeProcesses} process to complete...`, "info");
        }
      }, 1000);
    } else {
      activityRunning = false;
      isCycleRunning = activeProcesses > 0 || dailyActivityInterval !== null;
      updateMenu();
      updateStatus();
      safeRender();
    }
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "DIAM TESTNET AUTO BOT",
  autoPadding: true,
  fullUnicode: true,
  mouse: true,
  ignoreLocked: ["C-c", "q", "escape"]
});

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  height: 6,
  tags: true,
  style: { fg: "yellow", bg: "default" }
});

const statusBox = blessed.box({
  left: 0,
  top: 6,
  width: "100%",
  height: 3,
  tags: true,
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" } },
  content: "Status: Initializing...",
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  label: " Status ",
  wrap: true
});

const walletBox = blessed.list({
  label: " Wallet Information ",
  top: 9,
  left: 0,
  width: "40%",
  height: "35%",
  border: { type: "line", fg: "cyan" },
  style: { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } },
  scrollable: true,
  scrollbar: { bg: "cyan", fg: "black" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  content: "Loading wallet data..."
});

const logBox = blessed.log({
  label: " Transaction Logs ",
  top: 9,
  left: "41%",
  width: "60%",
  height: "100%-9",
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" }, scrollbar: { bg: "cyan" } },
  scrollable: true,
  alwaysScroll: true,
  scrollbar: true,
  tags: true,
  mouse: true,
  keys: true,
  vi: true
});

const menuBox = blessed.list({
  label: " Main Menu ",
  top: "45%",
  left: 0,
  width: "40%",
  height: "55%",
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" }, selected: { bg: "green" } },
  items: ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Exit"],
  keys: true,
  vi: true,
  mouse: true
});

const dailyActivitySubMenu = blessed.list({
  label: " Daily Activity Config ",
  top: "45%",
  left: 0,
  width: "40%",
  height: "55%",
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" }, selected: { bg: "green" } },
  items: ["Set Send DIAM Config", "Set Send Amount Config", "Back to Main Menu"],
  keys: true,
  vi: true,
  mouse: true,
  hidden: true
});

const repetitionsForm = blessed.form({
  label: " Enter Send Repetitions ",
  top: "center",
  left: "center",
  width: "30%",
  height: "30%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const repetitionsInput = blessed.textbox({
  parent: repetitionsForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const repetitionsSubmitButton = blessed.button({
  parent: repetitionsForm,
  top: 5,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green" }
  }
});

const sendAmountConfigForm = blessed.form({
  label: " Set Send Amount Config ",
  top: "center",
  left: "center",
  width: "30%",
  height: "50%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const minAmountInput = blessed.textbox({
  parent: sendAmountConfigForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  label: "Min Send Amount",
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const maxAmountInput = blessed.textbox({
  parent: sendAmountConfigForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  label: "Max Send Amount",
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const sendAmountSubmitButton = blessed.button({
  parent: sendAmountConfigForm,
  top: 9,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green" }
  }
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(dailyActivitySubMenu);
screen.append(repetitionsForm);
screen.append(sendAmountConfigForm);

if (!global.__neuraHandlersAttached) {
  global.__neuraHandlersAttached = true;

  function safeRemoveListeners(el, ev) {
    if (!el) return;
    if (typeof el.removeAllListeners === "function") {
      try { el.removeAllListeners(ev); } catch (e) {}
    } else if (typeof el.off === "function") {
      try { el.off(ev); } catch (e) {}
    }
  }

  function makeDebouncedHandler(fn, delay = 400) {
    let timer = null;
    return (...args) => {
      if (timer) return;
      try { fn(...args); } catch(e){}
      timer = setTimeout(() => { timer = null; }, delay);
    };
  }

  try {
    safeRemoveListeners(sendAmountSubmitButton, "press");
    safeRemoveListeners(sendAmountSubmitButton, "click");
    const handleSendSubmit = makeDebouncedHandler(() => {
      try { if (sendAmountConfigForm && typeof sendAmountConfigForm.submit === "function") sendAmountConfigForm.submit(); } catch(e){}
      try { screen.render(); } catch(e){}
    }, 400);
    sendAmountSubmitButton.on("press", handleSendSubmit);
    sendAmountSubmitButton.on("click", () => { try { screen.focusPush(sendAmountSubmitButton); } catch(e){}; handleSendSubmit(); });
  } catch(e){}

  try {
    safeRemoveListeners(repetitionsSubmitButton, "press");
    safeRemoveListeners(repetitionsSubmitButton, "click");
    const handleRepSubmit = makeDebouncedHandler(() => {
      try { if (repetitionsForm && typeof repetitionsForm.submit === "function") repetitionsForm.submit(); } catch(e){}
      try { screen.render(); } catch(e){}
    }, 400);
    repetitionsSubmitButton.on("press", handleRepSubmit);
    repetitionsSubmitButton.on("click", () => { try { screen.focusPush(repetitionsSubmitButton); } catch(e){}; handleRepSubmit(); });
  } catch(e){}
}

let renderQueue = [];
let isRendering = false;
function safeRender() {
  renderQueue.push(true);
  if (isRendering) return;
  isRendering = true;
  setTimeout(() => {
    try {
      if (!isHeaderRendered) {
        figlet.text("NT EXHAUST", { font: "ANSI Shadow" }, (err, data) => {
          if (!err) headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
          isHeaderRendered = true;
        });
      }
      screen.render();
    } catch (error) {
      addLog(`UI render error: ${error.message}`, "error");
    }
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
  const screenHeight = screen.height || 24;
  const screenWidth = screen.width || 80;

  headerBox.height = Math.max(6, Math.floor(screenHeight * 0.15));
  statusBox.top = headerBox.height;
  statusBox.height = Math.max(3, Math.floor(screenHeight * 0.07));

  walletBox.top = headerBox.height + statusBox.height;
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);

  logBox.top = headerBox.height + statusBox.height;
  logBox.left = Math.floor(screenWidth * 0.41);
  logBox.width = Math.floor(screenWidth * 0.6);
  logBox.height = screenHeight - (headerBox.height + statusBox.height);

  menuBox.top = headerBox.height + statusBox.height + walletBox.height;
  menuBox.width = Math.floor(screenWidth * 0.4);
  menuBox.height = screenHeight - (headerBox.height + statusBox.height + walletBox.height);

  if (menuBox.top != null) {
    dailyActivitySubMenu.top = menuBox.top;
    dailyActivitySubMenu.width = menuBox.width;
    dailyActivitySubMenu.height = menuBox.height;
    dailyActivitySubMenu.left = menuBox.left;
    repetitionsForm.width = Math.floor(screenWidth * 0.3);
    repetitionsForm.height = Math.floor(screenHeight * 0.3);
    sendAmountConfigForm.width = Math.floor(screenWidth * 0.3);
    sendAmountConfigForm.height = Math.floor(screenHeight * 0.5);
  }

  safeRender();
}

function updateStatus() {
  const isProcessing = activityRunning || isCycleRunning;
  const status = activityRunning
    ? `${loadingSpinner[spinnerIndex]} {yellow-fg}Running{/yellow-fg}`
    : isCycleRunning
      ? `${loadingSpinner[spinnerIndex]} {yellow-fg}Waiting for next cycle{/yellow-fg}`
      : "{green-fg}Idle{/green-fg}";
  const statusText = `Status: ${status} | Active Account: ${getShortAddress(walletInfo.address)} | Total Accounts: ${addresses.length} | Send: ${dailyActivityConfig.sendDiamRepetitions}x | DIAM TESTNET AUTO BOT`;
  try {
    statusBox.setContent(statusText);
  } catch (error) {
    addLog(`Status update error: ${error.message}`, "error");
  }
  if (isProcessing) {
    if (blinkCounter % 1 === 0) {
      statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
      borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
    }
    blinkCounter++;
  } else {
    statusBox.style.border.fg = "cyan";
  }
  spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
  safeRender();
}

async function updateWallets() {
  const walletData = await updateWalletData();
  const header = `{bold}{cyan-fg}     Address{/cyan-fg}{/bold}       {bold}{cyan-fg}DIAM{/cyan-fg}{/bold}`;
  const separator = "{grey-fg}----------------------------------{/grey-fg}";
  try {
    walletBox.setItems([header, separator, ...walletData]);
    walletBox.select(0);
  } catch (error) {
    addLog(`Wallet update error: ${error.message}`, "error");
  }
  safeRender();
}

function updateLogs() {
  try {
    logBox.setContent(transactionLogs.join("\n") || "{grey-fg}Tidak ada log tersedia.{/grey-fg}");
    logBox.setScrollPerc(100);
  } catch (error) {
    addLog(`Log update error: ${error.message}`, "error");
  }
  safeRender();
}

function updateMenu() {
  try {
    menuBox.setItems(
      isCycleRunning
        ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Exit"]
        : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Exit"]
    );
  } catch (error) {
    addLog(`Menu update error: ${error.message}`, "error");
  }
  safeRender();
}

const statusInterval = setInterval(updateStatus, 100);

menuBox.on("select", async item => {
  const action = item.getText();
  switch (action) {
    case "Start Auto Daily Activity":
      if (isCycleRunning) {
        addLog("Cycle is still running. Stop the current cycle first.", "error");
      } else {
        await runDailyActivity();
      }
      break;
    case "Stop Activity":
      shouldStop = true;
      if (dailyActivityInterval) {
        clearTimeout(dailyActivityInterval);
        dailyActivityInterval = null;
      }
      addLog("Stopping daily activity... Please wait for ongoing processes to complete.", "info");
      const stopCheckInterval = setInterval(() => {
        if (activeProcesses <= 0) {
          clearInterval(stopCheckInterval);
          activityRunning = false;
          isCycleRunning = false;
          shouldStop = false;
          hasLoggedSleepInterrupt = false;
          activeProcesses = 0;
          addLog(`Daily activity stopped successfully.`, "success");
          updateMenu();
          updateStatus();
          safeRender();
        } else {
          addLog(`Waiting for ${activeProcesses} process to complete...`, "info");
        }
      }, 1000);
      break;
    case "Set Manual Config":
      menuBox.hide();
      dailyActivitySubMenu.show();
      setTimeout(() => {
        if (dailyActivitySubMenu.visible) {
          screen.focusPush(dailyActivitySubMenu);
          dailyActivitySubMenu.select(0);
          safeRender();
        }
      }, 100);
      break;
    case "Clear Logs":
      clearTransactionLogs();
      break;
    case "Exit":
      clearInterval(statusInterval);
      process.exit(0);
  }
  menuBox.focus();
  safeRender();
});

dailyActivitySubMenu.on("select", item => {
  const action = item.getText();
  switch (action) {
    case "Set Send DIAM Config":
      repetitionsForm.show();
      repetitionsForm.configType = "sendDiam";
      setTimeout(() => {
        if (repetitionsForm.visible) {
          screen.focusPush(repetitionsInput);
          repetitionsInput.setValue(dailyActivityConfig.sendDiamRepetitions.toString());
          safeRender();
        }
      }, 100);
      break;
    case "Set Send Amount Config":
      sendAmountConfigForm.show();
      setTimeout(() => {
        if (sendAmountConfigForm.visible) {
          screen.focusPush(minAmountInput);
          minAmountInput.setValue(dailyActivityConfig.minSendAmount.toString());
          maxAmountInput.setValue(dailyActivityConfig.maxSendAmount.toString());
          safeRender();
        }
      }, 100);
      break;
    case "Back to Main Menu":
      dailyActivitySubMenu.hide();
      menuBox.show();
      setTimeout(() => {
        if (menuBox.visible) {
          screen.focusPush(menuBox);
          menuBox.select(0);
          safeRender();
        }
      }, 100);
      break;
  }
});

repetitionsInput.key(["enter"], () => {
  repetitionsForm.submit();
});

repetitionsForm.on("submit", () => {
  const repetitionsText = repetitionsInput.getValue().trim();
  let repetitions;
  try {
    repetitions = parseInt(repetitionsText, 10);
    if (isNaN(repetitions) || repetitions < 1 || repetitions > 1000) {
      addLog("Invalid input. Please enter a number between 1 and 1000.", "error");
      repetitionsInput.setValue("");
      screen.focusPush(repetitionsInput);
      safeRender();
      return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    repetitionsInput.setValue("");
    screen.focusPush(repetitionsInput);
    safeRender();
    return;
  }

  if (repetitionsForm.configType === "sendDiam") {
    dailyActivityConfig.sendDiamRepetitions = repetitions;
    addLog(`Send DIAM Config set to ${repetitions}`, "success");
  }
  saveConfig();
  updateStatus();

  repetitionsForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.select(0);
      safeRender();
    }
  }, 100);
});

repetitionsSubmitButton.on("press", () => {
  repetitionsForm.submit();
});

repetitionsForm.key(["escape"], () => {
  repetitionsForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.select(0);
      safeRender();
    }
  }, 100);
});

minAmountInput.key(["enter"], () => {
  screen.focusPush(maxAmountInput);
});

maxAmountInput.key(["enter"], () => {
  sendAmountConfigForm.submit();
});

sendAmountSubmitButton.on("press", () => {
  sendAmountConfigForm.submit();
});

sendAmountConfigForm.on("submit", () => {
  const minText = minAmountInput.getValue().trim();
  const maxText = maxAmountInput.getValue().trim();
  let minAmount, maxAmount;
  try {
    minAmount = parseFloat(minText);
    maxAmount = parseFloat(maxText);
    if (isNaN(minAmount) || isNaN(maxAmount) || minAmount <= 0 || maxAmount <= 0 || minAmount >= maxAmount) {
      addLog("Invalid input. Min and Max must be positive numbers with Min < Max.", "error");
      minAmountInput.setValue("");
      maxAmountInput.setValue("");
      screen.focusPush(minAmountInput);
      safeRender();
      return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    minAmountInput.setValue("");
    maxAmountInput.setValue("");
    screen.focusPush(minAmountInput);
    safeRender();
    return;
  }

  dailyActivityConfig.minSendAmount = minAmount;
  dailyActivityConfig.maxSendAmount = maxAmount;
  addLog(`Send Amount Config set to Min: ${minAmount}, Max: ${maxAmount}`, "success");
  saveConfig();
  updateStatus();

  sendAmountConfigForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.select(0);
      safeRender();
    }
  }, 100);
});

sendAmountConfigForm.key(["escape"], () => {
  sendAmountConfigForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.select(0);
      safeRender();
    }
  }, 100);
});

dailyActivitySubMenu.key(["escape"], () => {
  dailyActivitySubMenu.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.select(0);
      safeRender();
    }
  }, 100);
});

screen.key(["escape", "q", "C-c"], () => {
  addLog("Exiting application", "info");
  clearInterval(statusInterval);
  process.exit(0);
});

async function initialize() {
  loadAccountData();
  loadConfig();
  loadAddresses();
  loadProxies();
  recipientAddresses = loadRecipientAddresses();
  updateStatus();
  updateWallets();
  updateLogs();
  safeRender();
  menuBox.focus();
}

setTimeout(() => {
  adjustLayout();
  screen.on("resize", adjustLayout);
}, 100);

initialize();
