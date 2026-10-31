/**
 * PINTA PADEL TOUR – HUVUDMOTOR
 * Minimalistisk, serverlös padelturnering för 8 spelare på 2 banor.
 * Robust användarhantering: Arrangör (Admin), Spelare (med matchfokus) och Gästläge.
 */

(function () {
    'use strict';

    // =========================================================================
    // 1. KONSTANTER & TILLSTÅND (STATE)
    // =========================================================================

    const STORAGE_KEY = 'pinta_padel_data_v2';
    const AUTH_KEY = 'pinta_padel_user_v2';
    const ADMIN_KEYS_KEY = 'pinta_padel_adminkeys_v2';
    const LOGOUT_FLAG_KEY = 'pinta_explicit_logout_v2';

    const appState = {
        tournaments: [],
        deletedTournaments: [],
        activeTournamentId: null,
        currentUser: null,       // { id, name, role: 'admin'|'player', pin, tourneyKey }
        currentRoundIndex: 0,    // 0..6
        currentSubMatchIndex: 0, // 0..2 (Match 1, Match 2, Match 3 i Lag-serie 21)
        cloudConnected: false
    };

    const firebaseConfig = {
        apiKey: "AIzaSyBAypviK71lkZK2COxt09t6-aLCr9JeAp8",
        authDomain: "pinta-padel.firebaseapp.com",
        projectId: "pinta-padel",
        storageBucket: "pinta-padel.firebasestorage.app",
        messagingSenderId: "95267842872",
        appId: "1:95267842872:web:f317835fa879cff72aafcd",
        measurementId: "G-BSFFPSBBK3"
    };

    let db = null;
    let firestoreUnsubscribe = null;
    let broadcastChannel = null;
    let undoToastTimer = null;
    let audioCtx = null;
    let selectedPlayerForLogin = null;

    // Standard balanserad Americano-matris för 8 spelare (7 omgångar, 1 match per omgång)
    // Varje spelare spelar med alla andra 7 exakt en gång och möter alla två gånger.
    const SCHEDULE_MATRIX = [
        // Omgång 1
        { court1: [[0, 1], [2, 3]], court2: [[4, 5], [6, 7]] },
        // Omgång 2
        { court1: [[0, 2], [4, 6]], court2: [[1, 3], [5, 7]] },
        // Omgång 3
        { court1: [[0, 3], [5, 6]], court2: [[1, 2], [4, 7]] },
        // Omgång 4
        { court1: [[0, 4], [1, 5]], court2: [[2, 6], [3, 7]] },
        // Omgång 5
        { court1: [[0, 5], [2, 7]], court2: [[1, 6], [3, 4]] },
        // Omgång 6
        { court1: [[0, 6], [1, 7]], court2: [[2, 4], [3, 5]] },
        // Omgång 7
        { court1: [[0, 7], [3, 6]], court2: [[1, 4], [2, 5]] }
    ];

    // 1-faktorisering för 8 spelare (7 omgångar av 4 unika par)
    // Varje spelare bildar par med alla övriga 7 spelare exakt en gång (totalt 28 unika par).
    // I varje omgång möter paren varandra i 3 delmatcher: 7 omgångar x 3 matcher = 21 matcher per spelare!
    const PAIRING_ROUNDS_7 = [
        [[0, 7], [1, 6], [2, 5], [3, 4]], // Omgång 1
        [[1, 7], [2, 0], [3, 6], [4, 5]], // Omgång 2
        [[2, 7], [3, 1], [4, 0], [5, 6]], // Omgång 3
        [[3, 7], [4, 2], [5, 1], [6, 0]], // Omgång 4
        [[4, 7], [5, 3], [6, 2], [0, 1]], // Omgång 5
        [[5, 7], [6, 4], [0, 3], [1, 2]], // Omgång 6
        [[6, 7], [0, 5], [1, 4], [2, 3]]  // Omgång 7
    ];

    // 2-(8, 4, 3) Blockdesign för Bana-rotation 21 (Mini-Americano på 2 banor)
    // 7 omgångar där 8 spelare delas in i 2 banor med 4 spelare vardera.
    // Varje spelarpar delar bana i exakt 3 omgångar och spelar som partners exakt 3 matcher (1 match per delad bana).
    const COURT_ROTATION_ROUNDS_7 = [
        { court1: [0, 1, 2, 3], court2: [4, 5, 6, 7] }, // Omgång 1
        { court1: [0, 1, 4, 5], court2: [2, 3, 6, 7] }, // Omgång 2
        { court1: [0, 2, 4, 6], court2: [1, 3, 5, 7] }, // Omgång 3
        { court1: [0, 1, 6, 7], court2: [2, 3, 4, 5] }, // Omgång 4
        { court1: [0, 2, 5, 7], court2: [1, 3, 4, 6] }, // Omgång 5
        { court1: [0, 3, 4, 7], court2: [1, 2, 5, 6] }, // Omgång 6
        { court1: [0, 3, 5, 6], court2: [1, 2, 4, 7] }  // Omgång 7
    ];

    // =========================================================================
    // 2. LJUDMOTOR (WEB AUDIO API - INGA EXTERNA MP3-FILER)
    // =========================================================================

    function getAudioContext() {
        if (!audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) audioCtx = new AudioContextClass();
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    }

    function playTone(freq, duration = 0.08, type = 'sine', gainVal = 0.08) {
        try {
            const ctx = getAudioContext();
            if (!ctx) return;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, ctx.currentTime);
            gain.gain.setValueAtTime(gainVal, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + duration);
        } catch (e) {}
    }

    function playClick() { playTone(620, 0.04, 'sine', 0.06); }
    function playSuccess() {
        playTone(523.25, 0.08, 'sine', 0.08);
        setTimeout(() => playTone(659.25, 0.12, 'sine', 0.08), 80);
    }
    function playFanfare() {
        const notes = [523.25, 659.25, 783.99, 1046.50];
        notes.forEach((n, i) => {
            setTimeout(() => playTone(n, 0.15, 'triangle', 0.1), i * 90);
        });
    }
    function playScoreSaved() { playTone(880, 0.06, 'sine', 0.07); }
    function playDelete() { playTone(280, 0.15, 'sawtooth', 0.08); }

    // =========================================================================
    // 3. PERSISTENS (LOCALSTORAGE & SYNC)
    // =========================================================================

    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                appState.tournaments = parsed.tournaments || [];
                appState.deletedTournaments = parsed.deletedTournaments || [];
                appState.activeTournamentId = parsed.activeTournamentId || null;
            }
        } catch (e) {
            console.error('Kunde inte läsa state:', e);
        }

        // Läs inloggad användare
        try {
            const userRaw = localStorage.getItem(AUTH_KEY);
            if (userRaw) {
                appState.currentUser = JSON.parse(userRaw);
            } else {
                appState.currentUser = null;
            }
        } catch (e) {
            appState.currentUser = null;
        }

        // Kontrollera om användaren uttryckligen har loggat ut
        const isExplicitlyLoggedOut = sessionStorage.getItem(LOGOUT_FLAG_KEY) === 'true';

        // Om skaparen besöker sin egen turnering på denna enhet och INTE uttryckligen loggat ut:
        const active = getActiveTournament();
        if (active && !appState.currentUser && !isExplicitlyLoggedOut) {
            const adminKeys = getAdminKeys();
            if (active.adminKey && adminKeys[active.id] === active.adminKey) {
                appState.currentUser = {
                    id: (active.organizer && active.organizer.id) ? active.organizer.id : 'org_' + active.id,
                    name: (active.organizer && active.organizer.name) ? active.organizer.name : 'Arrangör',
                    role: 'admin',
                    tourneyKey: active.adminKey
                };
                saveUser();
            }
        }

        checkUrlForSharedTournament();
    }

    function saveState(skipCloud = false) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                tournaments: appState.tournaments,
                deletedTournaments: appState.deletedTournaments,
                activeTournamentId: appState.activeTournamentId
            }));
            broadcastLocalUpdate();
            if (!skipCloud) {
                syncToCloud();
            }
        } catch (e) {
            console.error('Kunde inte spara state:', e);
        }
    }

    function saveUser() {
        try {
            if (appState.currentUser) {
                localStorage.setItem(AUTH_KEY, JSON.stringify(appState.currentUser));
                sessionStorage.removeItem(LOGOUT_FLAG_KEY);
            } else {
                localStorage.removeItem(AUTH_KEY);
            }
        } catch (e) {}
    }

    function logoutUser() {
        appState.currentUser = null;
        saveUser();
        sessionStorage.setItem(LOGOUT_FLAG_KEY, 'true');

        // Rensa eventuella admin-parametrar i URL så man inte återinloggas vid sidomladdning
        try {
            const url = new URL(window.location.href);
            url.searchParams.delete('key');
            url.searchParams.delete('admin');
            history.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
        } catch (e) {}

        renderApp();
        playClick();
        showToast('👤 Du är nu utloggad (Gästläge).');
    }

    function getAdminKeys() {
        try {
            return JSON.parse(localStorage.getItem(ADMIN_KEYS_KEY) || '{}');
        } catch (e) {
            return {};
        }
    }

    function saveAdminKeyForTourney(tourneyId, key) {
        const keys = getAdminKeys();
        keys[tourneyId] = key;
        try {
            localStorage.setItem(ADMIN_KEYS_KEY, JSON.stringify(keys));
        } catch (e) {}
    }

    // =========================================================================
    // 4. REALTIDSSYNK (FIREBASE FIRESTORE & BROADCASTCHANNEL)
    // =========================================================================

    function initFirebase() {
        try {
            if (typeof firebase !== 'undefined') {
                if (!firebase.apps || !firebase.apps.length) {
                    firebase.initializeApp(firebaseConfig);
                }
                db = firebase.firestore();
                try {
                    db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
                } catch (e) {}
            }
        } catch (e) {
            console.error('Firebase init-fel:', e);
        }
    }

    try {
        if ('BroadcastChannel' in window) {
            broadcastChannel = new BroadcastChannel('pinta_padel_sync');
            broadcastChannel.onmessage = (event) => {
                if (event.data && event.data.type === 'SYNC') {
                    loadState();
                    renderApp();
                }
            };
        }
    } catch (e) {}

    function broadcastLocalUpdate() {
        if (broadcastChannel) {
            broadcastChannel.postMessage({ type: 'SYNC', timestamp: Date.now() });
        }
    }

    function initCloudSync() {
        const active = getActiveTournament();
        const dot = document.getElementById('syncDot');

        if (!active || !db) {
            if (dot) {
                dot.classList.add('offline');
                dot.title = 'Offline / Ingen molndatabas';
            }
            return;
        }

        // Avbryt eventuell tidigare snapshot-prenumeration
        if (firestoreUnsubscribe) {
            firestoreUnsubscribe();
            firestoreUnsubscribe = null;
        }

        try {
            const docRef = db.collection('tournaments').doc(active.id);

            firestoreUnsubscribe = docRef.onSnapshot((doc) => {
                if (dot) {
                    dot.classList.remove('offline');
                    dot.title = 'Firebase molndatabas ansluten';
                }
                appState.cloudConnected = true;

                if (doc.exists) {
                    const cloudTourney = doc.data();
                    if (cloudTourney && cloudTourney.id === appState.activeTournamentId) {
                        const idx = appState.tournaments.findIndex(t => t.id === cloudTourney.id);
                        const localTourney = idx >= 0 ? appState.tournaments[idx] : null;

                        const isPending = doc.metadata && doc.metadata.hasPendingWrites;
                        const cloudPlayerCount = (cloudTourney.players || []).length;
                        const localPlayerCount = (localTourney && localTourney.players) ? localTourney.players.length : 0;
                        const cloudUpdated = cloudTourney.updatedAt || 0;
                        const localUpdated = (localTourney && localTourney.updatedAt) || 0;

                        // Uppdatera alltid om snapshotet är bekräftat från servern,
                        // om molnet har fler/andra spelare, eller om molnets tidsstämpel är nyare/lika
                        if (!isPending || cloudPlayerCount !== localPlayerCount || cloudUpdated >= localUpdated || !localTourney) {
                            if (idx >= 0) {
                                appState.tournaments[idx] = cloudTourney;
                            } else {
                                appState.tournaments.push(cloudTourney);
                            }
                            saveState(true);
                            renderApp();
                        }
                    }
                } else {
                    // Turneringen finns inte i Firestore än -> ladda upp lokal version
                    syncToCloud();
                }
            }, (error) => {
                console.warn('Firestore snapshot fel:', error);
                appState.cloudConnected = false;
                if (dot) {
                    dot.classList.add('offline');
                    dot.title = 'Offline / Firestore fel: ' + (error.message || error.code);
                }
            });
        } catch (e) {
            console.error('Kunde inte koppla upp Firestore snapshot:', e);
            if (dot) dot.classList.add('offline');
        }
    }

    function syncToCloud() {
        const active = getActiveTournament();
        if (!active || !db) return;
        try {
            active.updatedAt = Date.now();
            const docRef = db.collection('tournaments').doc(active.id);
            const plainTourney = JSON.parse(JSON.stringify(active));
            docRef.set(plainTourney, { merge: true }).catch((err) => {
                console.error('Firestore save error:', err);
                const dot = document.getElementById('syncDot');
                if (dot) {
                    dot.classList.add('offline');
                    dot.title = 'Fel vid sparning till Firestore (kontrollera Firestore testregler)';
                }
            });
        } catch (e) {
            console.error('Kunde inte synka till Firestore:', e);
        }
    }

    // =========================================================================
    // 5. URL-DELNING & INBJUDAN
    // =========================================================================

    function checkUrlForSharedTournament() {
        const urlParams = new URLSearchParams(window.location.search);
        const tourneyId = urlParams.get('t') || urlParams.get('id');
        const adminKeyParam = urlParams.get('key') || urlParams.get('admin');

        if (tourneyId) {
            let found = appState.tournaments.find(t => t.id === tourneyId);
            if (!found) {
                const tourneyName = urlParams.get('n') || urlParams.get('namn') || 'Pinta Padel Tour';
                found = {
                    id: tourneyId,
                    name: decodeURIComponent(tourneyName),
                    format: 'option1',
                    pointSystem: 'games',
                    status: 'lobby',
                    isDrawn: false,
                    players: [],
                    rounds: [],
                    createdAt: new Date().toISOString(),
                    organizer: null
                };
                appState.tournaments.push(found);
            }
            appState.activeTournamentId = tourneyId;
            saveState(true);

            // Om vi har Firestore tillgängligt, hämta turneringen direkt från molnet
            if (db) {
                db.collection('tournaments').doc(tourneyId).get().then(doc => {
                    if (doc.exists) {
                        const cloudData = doc.data();
                        const idx = appState.tournaments.findIndex(t => t.id === tourneyId);
                        if (idx >= 0) {
                            appState.tournaments[idx] = cloudData;
                        } else {
                            appState.tournaments.push(cloudData);
                        }
                        saveState(true);
                        renderApp();
                        setTimeout(checkAutoInvitePrompt, 150);
                    }
                }).catch(err => console.warn('Kunde inte läsa tourney från Firestore:', err));
            }
        }

        const active = getActiveTournament();
        const isExplicitlyLoggedOut = sessionStorage.getItem(LOGOUT_FLAG_KEY) === 'true';

        if (adminKeyParam && active && !isExplicitlyLoggedOut) {
            const isMasterParam = adminKeyParam.toLowerCase() === 'ulrik' || adminKeyParam.toLowerCase() === 'eje';
            if (isMasterParam || (active.adminKey && active.adminKey === adminKeyParam)) {
                active.adminKey = adminKeyParam;
                saveAdminKeyForTourney(active.id, adminKeyParam);
                const adminName = adminKeyParam.toLowerCase() === 'eje' ? 'Eje' : (adminKeyParam.toLowerCase() === 'ulrik' ? 'Ulrik' : ((active.organizer && active.organizer.name) ? active.organizer.name : 'Arrangör'));
                appState.currentUser = {
                    id: (active.organizer && active.organizer.id) ? active.organizer.id : 'org_' + active.id,
                    name: adminName,
                    role: 'admin',
                    tourneyKey: adminKeyParam
                };
                saveUser();
                saveState();
            }
        }

        setTimeout(checkAutoInvitePrompt, 200);
    }

    function getShareableUrl(tourney, forAdmin = false) {
        if (!tourney) return window.location.origin + window.location.pathname;
        const base = window.location.origin + window.location.pathname;
        const cleanName = encodeURIComponent(tourney.name || 'Padel');
        if (forAdmin && tourney.adminKey) {
            return `${base}?t=${tourney.id}&n=${cleanName}&key=${tourney.adminKey}`;
        }
        return `${base}?t=${tourney.id}&n=${cleanName}`;
    }

    /**
     * Hämtar arrangörens namn på ett robust sätt
     */
    function getOrganizerName(tourney) {
        if (!tourney) return 'Arrangören';
        if (tourney.organizer && tourney.organizer.name && tourney.organizer.name.trim()) {
            return tourney.organizer.name.trim();
        }
        const orgPlayer = (tourney.players || []).find(p => p.isOrganizer);
        if (orgPlayer && orgPlayer.name && orgPlayer.name.trim()) {
            return orgPlayer.name.trim();
        }
        return 'Arrangören';
    }

    /**
     * Skapar ett snyggt, välkomnande inbjudningsmeddelande för WhatsApp och kopiering
     */
    function getInviteShareMessage(tourney) {
        if (!tourney) return '';
        const url = getShareableUrl(tourney, false);
        const tourneyName = (tourney.name || 'Padelturnering').trim();
        const organizerName = getOrganizerName(tourney);
        let formatName = 'Duo 21 – (Fast lag per omgång, möt alla)';
        if (tourney.format === 'classic7') {
            formatName = 'Klassisk 7 – (Standard Americano)';
        } else if (tourney.format === 'court21') {
            formatName = 'Quattro 21 – (4 på banan, rotera partner)';
        }

        return (
            `🎾 *Inbjudan till Padelturnering!*\n\n` +
            `🏆 *Turnering:* ${tourneyName}\n` +
            `👤 *Inbjuden av:* ${organizerName}\n` +
            `📋 *Format:* ${formatName}\n\n` +
            `Varmt välkommen! Klicka på länken för att välja din plats och följa spelschemat & liveresultaten direkt i mobilen:\n` +
            `👉 ${url}`
        );
    }

    /**
     * Skapar en komplett text/WhatsApp-resultatrapport som kan delas eller sparas som backup
     */
    function getTournamentSummaryReport(tourney) {
        if (!tourney) return '';

        const tourneyName = (tourney.name || 'Padelturnering').trim();
        const organizerName = getOrganizerName(tourney);
        let formatName = 'Duo 21 – (Fast lag per omgång, möt alla)';
        if (tourney.format === 'classic7') {
            formatName = 'Klassisk 7 – (Standard Americano)';
        } else if (tourney.format === 'court21') {
            formatName = 'Quattro 21 – (4 på banan, rotera partner)';
        }

        const now = new Date();
        const dateStr = now.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
        const timeStr = now.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
        const timeStampText = `${dateStr} kl ${timeStr}`;

        // Beräkna totalt antal matcher och spelade matcher
        let totalMatches = 0;
        let completedMatches = 0;
        const roundsOutput = [];

        (tourney.rounds || []).forEach((r, rIdx) => {
            const allM = getAllMatchesInRound(r);
            totalMatches += allM.length;
            const completedInRound = allM.filter(m => m.completed);
            completedMatches += completedInRound.length;

            if (completedInRound.length > 0) {
                const matchLines = [];

                if (r.subMatches && r.subMatches.length > 0) {
                    r.subMatches.forEach((sm, smIdx) => {
                        (sm.matches || []).forEach(m => {
                            if (m.completed) {
                                const t1 = (m.team1 || []).map(p => p.name).join(' & ');
                                const t2 = (m.team2 || []).map(p => p.name).join(' & ');
                                matchLines.push(`• M${smIdx + 1} (Bana ${m.court}): ${t1} vs ${t2} (${m.score1} - ${m.score2})`);
                            }
                        });
                    });
                } else {
                    (r.matches || []).forEach(m => {
                        if (m.completed) {
                            const t1 = (m.team1 || []).map(p => p.name).join(' & ');
                            const t2 = (m.team2 || []).map(p => p.name).join(' & ');
                            matchLines.push(`• Bana ${m.court}: ${t1} vs ${t2} (${m.score1} - ${m.score2})`);
                        }
                    });
                }

                if (matchLines.length > 0) {
                    roundsOutput.push(`*Omgång ${rIdx + 1}:*\n${matchLines.join('\n')}`);
                }
            }
        });

        // Tabell
        const leaderboard = calculateLeaderboard(tourney);
        const tableLines = [];
        leaderboard.forEach((item, idx) => {
            const medal = idx === 0 ? '🥇 ' : (idx === 1 ? '🥈 ' : (idx === 2 ? '🥉 ' : `${idx + 1}. `));
            const diffStr = item.diff > 0 ? `+${item.diff}` : `${item.diff}`;
            tableLines.push(`${medal}${item.name}: *${item.totalPoints}p* (${item.matchesPlayed} m, diff ${diffStr})`);
        });

        const statusLine = totalMatches > 0
            ? `📊 *Status:* ${completedMatches} av ${totalMatches} matcher spelade`
            : `📊 *Status:* Inga matcher lottade ännu`;

        const matchesSection = roundsOutput.length > 0
            ? roundsOutput.join('\n\n')
            : 'Inga matcher är färdigspelade ännu.';

        const url = getShareableUrl(tourney, false);

        return (
            `🎾 *PINTA PADEL TOUR – RESULTATRAPPORT*\n\n` +
            `🏆 *Turnering:* ${tourneyName}\n` +
            `👤 *Arrangör:* ${organizerName}\n` +
            `📋 *Format:* ${formatName}\n` +
            `🕒 *Tid:* ${timeStampText}\n` +
            `${statusLine}\n\n` +
            `━━━━━━━━━━━━━━━━━━━\n` +
            `🏆 *AKTUELL TABELL*\n` +
            `${tableLines.join('\n')}\n\n` +
            `━━━━━━━━━━━━━━━━━━━\n` +
            `🎾 *SPELADE MATCHER*\n` +
            `${matchesSection}\n\n` +
            `━━━━━━━━━━━━━━━━━━━\n` +
            `👉 *Följ live här:*\n${url}`
        );
    }

    /**
     * Visar inbjudningsdialogen för en deltagare som klickat på inbjudningslänken
     */
    function showInvitePromptModal(tourney) {
        if (!tourney) return;
        const nameText = document.getElementById('inviteTourneyNameText');
        const orgText = document.getElementById('inviteOrganizerNameText');
        const slotsNotice = document.getElementById('inviteSlotsNotice');
        const askStep = document.getElementById('inviteStepAsk');
        const nameStep = document.getElementById('inviteStepName');
        const inputName = document.getElementById('inviteJoinPlayerName');

        const orgName = getOrganizerName(tourney);
        const freeSlots = Math.max(0, 8 - (tourney.players ? tourney.players.length : 0));

        if (nameText) nameText.textContent = tourney.name || 'Padelturnering';
        if (orgText) orgText.textContent = orgName;
        if (slotsNotice) {
            slotsNotice.textContent = freeSlots === 1
                ? 'Endast 1 plats kvar!'
                : `${freeSlots} lediga platser kvar`;
        }

        if (askStep) askStep.style.display = 'block';
        if (nameStep) nameStep.style.display = 'none';
        if (inputName) inputName.value = '';

        openModal('modalInviteJoin');
    }

    /**
     * Kontrollerar om besökaren öppnade en inbjudningslänk och ska få frågan om att gå med
     */
    function checkAutoInvitePrompt() {
        const tourney = getActiveTournament();
        if (!tourney) return;

        // Bara om användaren kom via en länk med parameter (?t= eller ?id=)
        const urlParams = new URLSearchParams(window.location.search);
        const hasTourneyParam = urlParams.has('t') || urlParams.has('id');
        if (!hasTourneyParam) return;

        // Om arrangörslänk används ska arrangören inte tillfrågas om att gå med som spelare
        if (urlParams.has('key') || urlParams.has('admin')) return;

        // Om användaren redan är inloggad som arrangör
        if (isOrganizer()) return;

        // Om användaren redan är inloggad som spelare i denna turnering
        if (appState.currentUser && appState.currentUser.role === 'player') {
            const isAlreadyIn = (tourney.players || []).some(p => p.id === appState.currentUser.id);
            if (isAlreadyIn) return;
        }

        // Om turneringen redan är lottad eller full
        if (tourney.isDrawn || (tourney.players && tourney.players.length >= 8)) return;

        // Om användaren redan avböjt i denna session
        if (sessionStorage.getItem(`pinta_declined_invite_${tourney.id}`) === 'true') return;

        showInvitePromptModal(tourney);
    }

    // =========================================================================
    // 6. ANVÄNDARROLLER & BEHÖRIGHETER
    // =========================================================================

    function getActiveTournament() {
        return appState.tournaments.find(t => t.id === appState.activeTournamentId) || null;
    }

    function isOrganizer() {
        if (!appState.currentUser) return false;
        return appState.currentUser.role === 'admin';
    }

    function isPlayer() {
        if (!appState.currentUser) return false;
        return appState.currentUser.role === 'player';
    }

    function isGuest() {
        return !appState.currentUser;
    }

    function isCurrentUserInMatch(match) {
        if (!appState.currentUser) return false;
        const userId = appState.currentUser.id;
        const userName = (appState.currentUser.name || '').toLowerCase();

        const inTeam1 = (match.team1 || []).some(p => p.id === userId || (p.name && p.name.toLowerCase() === userName));
        const inTeam2 = (match.team2 || []).some(p => p.id === userId || (p.name && p.name.toLowerCase() === userName));

        return inTeam1 || inTeam2;
    }

    function canUserEditMatch(match) {
        if (!match) return false;
        // Arrangören har full behörighet att redigera alla matcher
        if (isOrganizer()) return true;

        // En spelare kan enbart mata in / spara resultatet i matchen de själva deltar i!
        if (isPlayer() && isCurrentUserInMatch(match)) return true;

        // Gäster och spelare på den andra banan kan inte redigera
        return false;
    }

    /**
     * Hämtar alla matcher i en omgång (stödjer både subMatches och traditionella matches)
     */
    function getAllMatchesInRound(round) {
        if (!round) return [];
        if (round.subMatches && round.subMatches.length > 0) {
            const list = [];
            round.subMatches.forEach(sm => {
                if (sm.matches) list.push(...sm.matches);
            });
            return list;
        }
        return round.matches || [];
    }

    /**
     * Hämtar den aktiva matchen för en specifik bana (0 = Bana 1, 1 = Bana 2)
     * baserat på aktuell delmatch (currentSubMatchIndex).
     */
    function getActiveMatchForCourt(round, courtIndex) {
        if (!round) return null;
        if (round.subMatches && round.subMatches.length > 0) {
            const subIdx = appState.currentSubMatchIndex || 0;
            const sub = round.subMatches[subIdx] || round.subMatches[0];
            return sub && sub.matches ? sub.matches[courtIndex] : null;
        }
        return round.matches ? round.matches[courtIndex] : null;
    }

    /**
     * Hittar lagkamraten för en spelare i den aktuella omgången
     */
    function getRoundPartner(round, userId, userName) {
        if (!round) return null;
        const allMatches = getAllMatchesInRound(round);
        const uName = (userName || '').toLowerCase();
        for (const m of allMatches) {
            const inT1 = (m.team1 || []).findIndex(p => p.id === userId || (p.name && uName && p.name.toLowerCase() === uName));
            if (inT1 !== -1 && m.team1.length === 2) {
                return m.team1[1 - inT1];
            }
            const inT2 = (m.team2 || []).findIndex(p => p.id === userId || (p.name && uName && p.name.toLowerCase() === uName));
            if (inT2 !== -1 && m.team2.length === 2) {
                return m.team2[1 - inT2];
            }
        }
        return null;
    }

    /**
     * Hämtar bana och partners för de 3 delmatcherna för en spelare i Bana-rotation 21
     */
    function getPlayerCourtInfoForRound(round, userId, userName) {
        if (!round || !round.subMatches || round.subMatches.length === 0) return null;
        const uName = (userName || '').toLowerCase();
        let userCourt = null;
        const partners = [];

        round.subMatches.forEach(sm => {
            (sm.matches || []).forEach(m => {
                const inT1 = (m.team1 || []).findIndex(p => p.id === userId || (p.name && uName && p.name.toLowerCase() === uName));
                if (inT1 !== -1) {
                    userCourt = m.court;
                    const partnerObj = m.team1[1 - inT1];
                    partners.push(partnerObj ? partnerObj.name : 'Okänd');
                }
                const inT2 = (m.team2 || []).findIndex(p => p.id === userId || (p.name && uName && p.name.toLowerCase() === uName));
                if (inT2 !== -1) {
                    userCourt = m.court;
                    const partnerObj = m.team2[1 - inT2];
                    partners.push(partnerObj ? partnerObj.name : 'Okänd');
                }
            });
        });

        if (userCourt !== null) {
            return { court: userCourt, partners: partners };
        }
        return null;
    }

    /**
     * Hämtar de 4 spelarna på en viss bana i en omgång
     */
    function getCourtPlayersFromRound(round, courtNum) {
        if (!round) return [];
        if (courtNum === 1 && round.court1Players && round.court1Players.length > 0) return round.court1Players;
        if (courtNum === 2 && round.court2Players && round.court2Players.length > 0) return round.court2Players;
        if (round.subMatches && round.subMatches[0] && round.subMatches[0].matches) {
            const m = round.subMatches[0].matches.find(match => match.court === courtNum);
            if (m) {
                return [...(m.team1 || []), ...(m.team2 || [])];
            }
        }
        return [];
    }

    // =========================================================================
    // 7. TURNERINGSHANTERING (SKAPA, LOTTA, RADERA)
    // =========================================================================

    function createNewTournament(name, organizerName, organizerPlays = true, format = 'option1', pointSystem = 'games') {
        const id = 'pt_' + Date.now();
        const adminKey = 'adm_' + Math.random().toString(36).substring(2, 9);
        const adminCode = 'PT-' + Math.floor(10 + Math.random() * 90);
        const orgCleanName = organizerName.trim() || 'Arrangör';

        const newTourney = {
            id: id,
            name: name.trim() || 'Padelturnering',
            format: format,
            pointSystem: pointSystem,
            createdAt: new Date().toISOString(),
            status: 'lobby',
            isDrawn: false,
            adminKey: adminKey,
            adminCode: adminCode,
            organizer: {
                id: 'org_' + id,
                name: orgCleanName
            },
            players: [],
            rounds: []
        };

        // Om arrangören spelar själv -> sätts på Plats 1 med egen PIN
        if (organizerPlays) {
            const orgPin = Math.floor(1000 + Math.random() * 9000).toString();
            newTourney.players.push({
                id: 'p_org_' + id,
                name: orgCleanName,
                pin: orgPin,
                isOrganizer: true
            });
        }

        saveAdminKeyForTourney(id, adminKey);
        appState.tournaments.unshift(newTourney);
        appState.activeTournamentId = id;

        // Skaparen blir inloggad som arrangör
        appState.currentUser = {
            id: 'org_' + id,
            name: orgCleanName,
            role: 'admin',
            tourneyKey: adminKey
        };

        saveUser();
        saveState();
        initCloudSync();
        renderApp();
        switchView('viewPlayers');
        playSuccess();
        showToast(`🎾 Turneringen "${newTourney.name}" skapades! Du är inloggad som arrangör.`);
    }

    function registerPlayer(tourney, name, slotIndex) {
        if (!tourney) return false;

        // Bara en inloggad arrangör ska kunna lägga till fler spelare.
        // En inloggad spelare kan INTE lägga till fler spelare.
        if (isPlayer()) {
            alert('Endast en inloggad arrangör kan lägga till fler spelare.');
            return false;
        }

        if (tourney.players.length >= 8) {
            alert('Turneringen är redan full (8 spelare).');
            return false;
        }

        const cleanName = name.trim();
        if (!cleanName) return false;

        // Kontrollera att inte samma spelarnamn ges flera gånger (skiftlägesokänsligt)
        const nameLower = cleanName.toLowerCase();
        const isDuplicate = (tourney.players || []).some(p => p.name.trim().toLowerCase() === nameLower);
        if (isDuplicate) {
            alert(`Spelarnamnet "${cleanName}" finns redan i turneringen. Samma namn kan inte användas flera gånger. Välj ett annat namn eller lägg till initial/efternamn.`);
            return false;
        }

        // Validering godkänd -> Stäng popupen OMEDELBART så användaren får direkt respons
        closeModal('modalTakeSlot');
        closeModal('modalInviteJoin');
        const inputEl = document.getElementById('takeSlotPlayerName');
        if (inputEl) inputEl.value = '';
        const inviteInput = document.getElementById('inviteJoinPlayerName');
        if (inviteInput) inviteInput.value = '';

        const pin = Math.floor(1000 + Math.random() * 9000).toString();
        const newPlayer = {
            id: 'p_' + Date.now() + '_' + Math.random().toString(36).substring(2, 5),
            name: cleanName,
            pin: pin,
            isOrganizer: false
        };

        tourney.players.push(newPlayer);

        const wasOrganizer = isOrganizer();

        // När man som spelare går med i turnering och inte är inloggad -> logga in direkt som denna spelare!
        if (!wasOrganizer) {
            appState.currentUser = {
                id: newPlayer.id,
                name: newPlayer.name,
                pin: newPlayer.pin,
                role: 'player'
            };
            sessionStorage.removeItem(LOGOUT_FLAG_KEY);
            saveUser();
        }

        saveState();
        renderApp();

        if (wasOrganizer) {
            // Arrangör lägger till spelare: popupen är redan stängd, bekräfta med toast.
            playSuccess();
            showToast(`✓ ${escapeHtml(newPlayer.name)} lades till (PIN: ${newPlayer.pin})`);
            return true;
        }

        // För gäster/spelare som anmäler sig själva på sin egen mobil: visa PIN-bekräftelse
        const modalTitle = document.getElementById('pinConfirmTitle');
        const modalDesc = document.getElementById('pinConfirmDesc');
        const modalLabel = document.getElementById('pinDisplayLabel');
        const modalTip = document.getElementById('pinConfirmTip');
        const modalCode = document.getElementById('pinConfirmCode');
        const copyBtn = document.getElementById('btnCopyPinConfirm');
        const closeBtn = document.getElementById('btnClosePinConfirm');

        if (modalCode) modalCode.textContent = newPlayer.pin;
        if (modalTitle) modalTitle.textContent = `🎉 Välkommen, ${escapeHtml(newPlayer.name)}!`;
        if (modalDesc) modalDesc.innerHTML = `Du är nu anmäld och <strong>automatiskt inloggad</strong> på Plats ${tourney.players.length} av 8.`;
        if (modalLabel) modalLabel.textContent = 'Din personliga inloggningskod:';
        if (modalTip) modalTip.innerHTML = `<strong>Spara din 4-siffriga kod!</strong> Koden visas även vid ditt namn i spelarlistan (PIN: ${newPlayer.pin}). Du använder den om du byter telefon eller behöver logga in igen.`;
        if (copyBtn) copyBtn.textContent = `📋 Kopiera min kod (${newPlayer.pin})`;
        if (closeBtn) closeBtn.textContent = 'Jag har sparat koden – Fortsätt';

        openModal('modalPinConfirm');
        playSuccess();
        return true;
    }

    function openTakeSlotModal(slotIndex) {
        const tourney = getActiveTournament();
        if (!tourney) return;

        if (isPlayer()) {
            alert('Endast en inloggad arrangör kan lägga till fler spelare.');
            return;
        }

        const slotNum = parseInt(slotIndex, 10) + 1;
        const titleEl = document.getElementById('takeSlotModalTitle');
        const labelEl = document.getElementById('takeSlotNameLabel');
        const inputEl = document.getElementById('takeSlotPlayerName');
        const hintEl = document.getElementById('takeSlotHint');
        const submitBtn = document.getElementById('btnSubmitTakeSlot');

        document.getElementById('takeSlotIndex').value = slotIndex;
        if (inputEl) inputEl.value = '';

        if (isOrganizer()) {
            if (titleEl) titleEl.textContent = `Lägg till spelare (Plats ${slotNum} av 8)`;
            if (labelEl) labelEl.textContent = 'Spelarens namn:';
            if (inputEl) inputEl.placeholder = 'Förnamn eller smeknamn';
            if (hintEl) hintEl.textContent = 'Spelaren får en 4-siffrig PIN-kod som du kan ge till spelaren.';
            if (submitBtn) submitBtn.textContent = 'Lägg till spelare';
        } else {
            if (titleEl) titleEl.textContent = `Gå med i turneringen (Plats ${slotNum} av 8)`;
            if (labelEl) labelEl.textContent = 'Ditt namn:';
            if (inputEl) inputEl.placeholder = 'Skriv ditt namn';
            if (hintEl) hintEl.textContent = 'Du loggas in automatiskt och får din personliga 4-siffriga kod.';
            if (submitBtn) submitBtn.textContent = 'Gå med & visa min kod';
        }

        openModal('modalTakeSlot');
        if (inputEl) setTimeout(() => inputEl.focus(), 100);
    }

    function openEditPlayerModal(playerIndex) {
        const tourney = getActiveTournament();
        if (!tourney || !tourney.players || !tourney.players[playerIndex]) return;
        const player = tourney.players[playerIndex];

        document.getElementById('editPlayerIndex').value = playerIndex;
        document.getElementById('editPlayerNameInput').value = player.name;
        document.getElementById('editPlayerPinInput').value = player.pin || '';

        openModal('modalEditPlayer');
    }

    function saveEditedPlayer(playerIndex, newName, newPin) {
        const tourney = getActiveTournament();
        if (!tourney || !tourney.players || !tourney.players[playerIndex]) return;
        const player = tourney.players[playerIndex];
        const oldName = player.name;
        const cleanName = newName.trim();
        const cleanPin = (newPin || '').trim();

        if (!cleanName) {
            alert('Spelarens namn kan inte vara tomt.');
            return;
        }

        // Kontrollera att namnet inte redan är taget av en annan spelare
        const nameLower = cleanName.toLowerCase();
        const isDuplicate = tourney.players.some((p, idx) => idx !== playerIndex && p.name.trim().toLowerCase() === nameLower);
        if (isDuplicate) {
            alert(`Spelarnamnet "${cleanName}" finns redan i turneringen. Samma namn kan inte användas flera gånger.`);
            return;
        }

        player.name = cleanName;
        if (cleanPin && cleanPin.length === 4) {
            player.pin = cleanPin;
        }

        // Uppdatera spelarens namn i alla lottade omgångar och matcher
        if (tourney.rounds) {
            tourney.rounds.forEach(r => {
                getAllMatchesInRound(r).forEach(m => {
                    (m.team1 || []).forEach(p => {
                        if (p.id === player.id) p.name = cleanName;
                    });
                    (m.team2 || []).forEach(p => {
                        if (p.id === player.id) p.name = cleanName;
                    });
                });
            });
        }

        // Om detta var arrangören, uppdatera arrangörens namn i turneringen
        if (player.isOrganizer && tourney.organizer) {
            tourney.organizer.name = cleanName;
        }

        // Om den inloggade användaren är denna spelare, uppdatera sessionen
        if (appState.currentUser && appState.currentUser.id === player.id) {
            appState.currentUser.name = cleanName;
            appState.currentUser.pin = player.pin;
            saveUser();
        }

        saveState();
        renderApp();
        closeModal('modalEditPlayer');
        playSuccess();
        showToast(`✓ Spelare uppdaterad: "${cleanName}" (PIN: ${player.pin})`);
    }

    function removePlayer(tourney, playerIndex) {
        if (!tourney || !tourney.players || !tourney.players[playerIndex]) return;
        if (!isOrganizer()) {
            alert('Endast turneringens arrangör kan ta bort anmälda spelare.');
            return;
        }

        const player = tourney.players[playerIndex];

        if (tourney.isDrawn) {
            if (confirm(`Turneringen är redan lottad. Vill du byta namn på "${player.name}" till en reserv/ersättare istället för att ta bort platsen helt?`)) {
                openEditPlayerModal(playerIndex);
                return;
            }
        }

        if (confirm(`Vill du ta bort "${player.name}" från turneringen? Platsen blir ledig.`)) {
            // Om den borttagna spelaren var inloggad på denna enhet -> logga ut
            if (appState.currentUser && appState.currentUser.id === player.id) {
                logoutUser();
            }
            tourney.players.splice(playerIndex, 1);
            saveState();
            renderApp();
            playClick();
            showToast(`"${player.name}" togs bort.`);
        }
    }

    /**
     * Lottning av spelschema (8 spelare, 7 omgångar)
     */
    function drawSchedule(tourney) {
        if (!tourney || tourney.isDrawn) return;
        if (tourney.players.length !== 8) {
            alert('Alla 8 platser måste vara fyllda innan lottning kan genomföras.');
            return;
        }
        if (!isOrganizer()) {
            alert('Endast arrangören kan genomföra lottningen.');
            return;
        }

        // Slumpa spelarnas ordning 1..8
        const shuffled = [...tourney.players].sort(() => Math.random() - 0.5);
        tourney.players = shuffled;

        const rounds = [];

        if (tourney.format === 'classic7') {
            // Klassisk Americano (7 omgångar x 1 match per bana = 7 matcher per spelare)
            SCHEDULE_MATRIX.forEach((roundData, rIndex) => {
                const court1Pairs = roundData.court1;
                const court2Pairs = roundData.court2;

                rounds.push({
                    roundNumber: rIndex + 1,
                    matches: [
                        {
                            court: 1,
                            team1: [shuffled[court1Pairs[0][0]], shuffled[court1Pairs[0][1]]],
                            team2: [shuffled[court1Pairs[1][0]], shuffled[court1Pairs[1][1]]],
                            score1: 0,
                            score2: 0,
                            completed: false
                        },
                        {
                            court: 2,
                            team1: [shuffled[court2Pairs[0][0]], shuffled[court2Pairs[0][1]]],
                            team2: [shuffled[court2Pairs[1][0]], shuffled[court2Pairs[1][1]]],
                            score1: 0,
                            score2: 0,
                            completed: false
                        }
                    ]
                });
            });
        } else if (tourney.format === 'court21') {
            // Bana-rotation 21 (Mini-Americano: 4 spelare på bana 1, 4 på bana 2)
            // Varje bana spelar 3 delmatcher: alla spelar med alla på banan
            COURT_ROTATION_ROUNDS_7.forEach((roundData, rIndex) => {
                const c1 = roundData.court1.map(idx => shuffled[idx]);
                const c2 = roundData.court2.map(idx => shuffled[idx]);

                const subMatches = [
                    {
                        subMatchNumber: 1,
                        matches: [
                            { court: 1, team1: [c1[0], c1[1]], team2: [c1[2], c1[3]], score1: 0, score2: 0, completed: false },
                            { court: 2, team1: [c2[0], c2[1]], team2: [c2[2], c2[3]], score1: 0, score2: 0, completed: false }
                        ]
                    },
                    {
                        subMatchNumber: 2,
                        matches: [
                            { court: 1, team1: [c1[0], c1[2]], team2: [c1[1], c1[3]], score1: 0, score2: 0, completed: false },
                            { court: 2, team1: [c2[0], c2[2]], team2: [c2[1], c2[3]], score1: 0, score2: 0, completed: false }
                        ]
                    },
                    {
                        subMatchNumber: 3,
                        matches: [
                            { court: 1, team1: [c1[0], c1[3]], team2: [c1[1], c1[2]], score1: 0, score2: 0, completed: false },
                            { court: 2, team1: [c2[0], c2[3]], team2: [c2[1], c2[2]], score1: 0, score2: 0, completed: false }
                        ]
                    }
                ];

                rounds.push({
                    roundNumber: rIndex + 1,
                    court1Players: c1,
                    court2Players: c2,
                    subMatches: subMatches,
                    matches: subMatches[0].matches // bakåtkompatibilitet
                });
            });
        } else {
            // Standard: Lag-serie 21 (7 omgångar x 3 delmatcher = 21 matcher per spelare)
            PAIRING_ROUNDS_7.forEach((roundPairs, rIndex) => {
                const pA = [shuffled[roundPairs[0][0]], shuffled[roundPairs[0][1]]];
                const pB = [shuffled[roundPairs[1][0]], shuffled[roundPairs[1][1]]];
                const pC = [shuffled[roundPairs[2][0]], shuffled[roundPairs[2][1]]];
                const pD = [shuffled[roundPairs[3][0]], shuffled[roundPairs[3][1]]];

                const subMatches = [
                    {
                        subMatchNumber: 1,
                        matches: [
                            { court: 1, team1: pA, team2: pB, score1: 0, score2: 0, completed: false },
                            { court: 2, team1: pC, team2: pD, score1: 0, score2: 0, completed: false }
                        ]
                    },
                    {
                        subMatchNumber: 2,
                        matches: [
                            { court: 1, team1: pA, team2: pC, score1: 0, score2: 0, completed: false },
                            { court: 2, team1: pB, team2: pD, score1: 0, score2: 0, completed: false }
                        ]
                    },
                    {
                        subMatchNumber: 3,
                        matches: [
                            { court: 1, team1: pA, team2: pD, score1: 0, score2: 0, completed: false },
                            { court: 2, team1: pB, team2: pC, score1: 0, score2: 0, completed: false }
                        ]
                    }
                ];

                rounds.push({
                    roundNumber: rIndex + 1,
                    subMatches: subMatches,
                    matches: subMatches[0].matches // bakåtkompatibilitet
                });
            });
        }

        tourney.rounds = rounds;
        tourney.isDrawn = true;
        tourney.status = 'active';

        appState.currentRoundIndex = 0;
        appState.currentSubMatchIndex = 0;

        saveState();
        renderApp();
        playFanfare();
        showToast('🎲 Lottningen är klar! Spelschemat är redo.');
    }

    /**
     * Radera turnering – Fullständig nollställning och återgång till Startskärmen
     */
    function deleteTournament(tourneyId, permanent = false) {
        if (permanent) {
            const pIdx = appState.deletedTournaments.findIndex(t => t.id === tourneyId);
            if (pIdx >= 0) {
                appState.deletedTournaments.splice(pIdx, 1);
                saveState(true);
                if (db) {
                    db.collection('tournaments').doc(tourneyId).delete().catch(() => {});
                }
                renderArchiveModal();
                playClick();
            }
            return;
        }

        const idx = appState.tournaments.findIndex(t => t.id === tourneyId);
        if (idx < 0) return;

        const tourney = appState.tournaments.splice(idx, 1)[0];
        tourney.deletedAt = new Date().toISOString();
        appState.deletedTournaments.unshift(tourney);

        // Nollställ allt till startskärm
        appState.activeTournamentId = null;

        // Om användaren var inloggad som spelare i turneringen, nollställ sessionen
        if (appState.currentUser && appState.currentUser.role === 'player') {
            appState.currentUser = null;
            saveUser();
        }

        try {
            history.replaceState(null, '', window.location.pathname);
        } catch (e) {}

        document.title = 'Pinta Padel Tour – Turneringsmotor';

        saveState();
        renderApp();
        playDelete();
        showUndoToast(tourney);
    }

    function restoreTournament(tourneyId) {
        const idx = appState.deletedTournaments.findIndex(t => t.id === tourneyId);
        if (idx < 0) return;

        const tourney = appState.deletedTournaments.splice(idx, 1)[0];
        delete tourney.deletedAt;
        appState.tournaments.unshift(tourney);
        appState.activeTournamentId = tourney.id;

        saveState();
        initCloudSync();
        renderApp();
        switchView('viewPlayers');
        playSuccess();
        showToast(`↺ Turneringen "${tourney.name}" är återställd.`);
    }

    // =========================================================================
    // 8. RESULTAT & TABELLBERÄKNING
    // =========================================================================

    function calculateLeaderboard(tourney) {
        if (!tourney || !tourney.players) return [];

        const stats = {};
        tourney.players.forEach(p => {
            stats[p.id] = {
                id: p.id,
                name: p.name,
                matchesPlayed: 0,
                wins: 0,
                losses: 0,
                draws: 0,
                pointsScored: 0,
                pointsConceded: 0,
                diff: 0,
                totalPoints: 0
            };
        });

        (tourney.rounds || []).forEach(r => {
            getAllMatchesInRound(r).forEach(m => {
                if (m.completed) {
                    const s1 = parseInt(m.score1, 10) || 0;
                    const s2 = parseInt(m.score2, 10) || 0;

                    m.team1.forEach(p => {
                        if (!stats[p.id]) return;
                        stats[p.id].matchesPlayed += 1;
                        stats[p.id].pointsScored += s1;
                        stats[p.id].pointsConceded += s2;
                        if (s1 > s2) stats[p.id].wins += 1;
                        else if (s1 < s2) stats[p.id].losses += 1;
                        else stats[p.id].draws += 1;
                    });

                    m.team2.forEach(p => {
                        if (!stats[p.id]) return;
                        stats[p.id].matchesPlayed += 1;
                        stats[p.id].pointsScored += s2;
                        stats[p.id].pointsConceded += s1;
                        if (s2 > s1) stats[p.id].wins += 1;
                        else if (s2 < s1) stats[p.id].losses += 1;
                        else stats[p.id].draws += 1;
                    });
                }
            });
        });

        const list = Object.values(stats);
        list.forEach(item => {
            item.diff = item.pointsScored - item.pointsConceded;
            item.totalPoints = item.pointsScored;
        });

        // Sortering: Poäng -> Målskillnad -> Flest vinster -> Flest gjorda poäng
        list.sort((a, b) => {
            if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
            if (b.diff !== a.diff) return b.diff - a.diff;
            if (b.wins !== a.wins) return b.wins - a.wins;
            return b.pointsScored - a.pointsScored;
        });

        return list;
    }

    function saveMatchScore(courtIndex) {
        const tourney = getActiveTournament();
        if (!tourney || !tourney.rounds || !tourney.rounds[appState.currentRoundIndex]) return;

        const round = tourney.rounds[appState.currentRoundIndex];
        const match = getActiveMatchForCourt(round, courtIndex);
        if (!match) return;

        if (!canUserEditMatch(match)) {
            alert('Du har inte behörighet att rapportera denna match.');
            return;
        }

        const input1 = document.getElementById(`court${courtIndex + 1}Score1`);
        const input2 = document.getElementById(`court${courtIndex + 1}Score2`);

        const s1 = Math.max(0, parseInt(input1.value, 10) || 0);
        const s2 = Math.max(0, parseInt(input2.value, 10) || 0);

        match.score1 = s1;
        match.score2 = s2;
        match.completed = true;

        saveState();
        renderApp();
        playScoreSaved();
        const subLabel = (round.subMatches && round.subMatches.length > 0) ? ` (Match ${appState.currentSubMatchIndex + 1})` : '';
        showToast(`Bana ${courtIndex + 1}${subLabel} sparad: ${s1} – ${s2}`);
    }

    // =========================================================================
    // 9. RENDERING & ANVÄNDARVISNING
    // =========================================================================

    function renderApp() {
        const tourney = getActiveTournament();

        const elHeaderTitle = document.getElementById('headerTourneyTitle');
        const elHeaderSub = document.getElementById('headerTourneySub');
        const elBottomNav = document.getElementById('bottomNav');
        const elStartScreen = document.getElementById('viewStartScreen');

        // 1. Startskärm vs Aktiv Turnering
        if (!tourney) {
            elStartScreen.style.display = 'flex';
            document.querySelectorAll('.app-view').forEach(v => v.style.display = 'none');
            if (elBottomNav) elBottomNav.style.display = 'none';

            if (elHeaderTitle) elHeaderTitle.textContent = 'Pinta Padel';
            if (elHeaderSub) elHeaderSub.textContent = 'Ingen aktiv turnering';

            const totalSaved = appState.tournaments.length + appState.deletedTournaments.length;
            const btnArchive = document.getElementById('btnStartArchive');
            const countEl = document.getElementById('startArchiveCount');
            if (btnArchive) {
                if (totalSaved > 0) {
                    btnArchive.style.display = 'block';
                    if (countEl) countEl.textContent = totalSaved;
                } else {
                    btnArchive.style.display = 'none';
                }
            }
            renderUserStatus();
            return;
        }

        // Aktiv turnering finns
        elStartScreen.style.display = 'none';
        if (elBottomNav) elBottomNav.style.display = 'flex';

        if (elHeaderTitle) elHeaderTitle.textContent = tourney.name;
        if (elHeaderSub) {
            if (tourney.format === 'classic7') {
                elHeaderSub.textContent = 'Klassisk 7 – (Standard Americano)';
            } else if (tourney.format === 'court21') {
                elHeaderSub.textContent = 'Quattro 21 – (4 på banan, rotera partner)';
            } else {
                elHeaderSub.textContent = 'Duo 21 – (Fast lag per omgång, möt alla)';
            }
        }

        renderUserStatus();
        renderPlayersView(tourney);
        renderMatchesView(tourney);
        renderTableView(tourney);
        renderMenuView(tourney);
    }

    /**
     * Header & Användarstatus
     */
    function renderUserStatus() {
        const iconEl = document.getElementById('headerUserIcon');
        const nameEl = document.getElementById('headerUserName');
        const btnUser = document.getElementById('btnUserHeader');

        if (appState.currentUser) {
            if (appState.currentUser.role === 'admin') {
                if (iconEl) iconEl.textContent = '👑';
                if (nameEl) nameEl.textContent = `Arrangör (${appState.currentUser.name})`;
                if (btnUser) btnUser.style.borderColor = 'var(--primary)';
            } else {
                if (iconEl) iconEl.textContent = '🎾';
                if (nameEl) nameEl.textContent = appState.currentUser.name;
                if (btnUser) btnUser.style.borderColor = 'rgba(0, 230, 118, 0.4)';
            }
        } else {
            // INGEN STÅR SOM INLOGGAD
            if (iconEl) iconEl.textContent = '👤';
            if (nameEl) nameEl.textContent = 'Logga in';
            if (btnUser) btnUser.style.borderColor = 'var(--border-subtle)';
        }
    }

    /**
     * Flik 1: Spelare
     */
    function renderPlayersView(tourney) {
        const count = tourney.players.length;
        const percent = Math.min(100, Math.round((count / 8) * 100));

        const badge = document.getElementById('playerCountBadge');
        const bar = document.getElementById('playerProgressBar');
        const navBadge = document.getElementById('navPlayerBadge');

        if (badge) badge.textContent = `${count} av 8 anmälda`;
        if (bar) bar.style.width = `${percent}%`;
        if (navBadge) navBadge.textContent = `${count}/8`;

        const rosterEl = document.getElementById('rosterList');
        if (!rosterEl) return;
        rosterEl.innerHTML = '';

        const isUserAdmin = isOrganizer();
        const currentUserId = appState.currentUser ? appState.currentUser.id : null;
        const currentUserName = appState.currentUser ? (appState.currentUser.name || '').toLowerCase() : '';

        for (let i = 0; i < 8; i++) {
            const player = tourney.players[i];
            const row = document.createElement('div');
            row.className = 'roster-slot-row';

            if (player) {
                const isMe = (currentUserId && player.id === currentUserId) || 
                             (currentUserName && player.name.toLowerCase() === currentUserName);

                if (isMe) row.classList.add('is-current-user');

                let badgeHtml = '';
                if (player.isOrganizer && isMe) {
                    badgeHtml = '<span class="badge-you">Du / Arrangör</span>';
                } else if (isMe) {
                    badgeHtml = '<span class="badge-you">Du</span>';
                } else if (player.isOrganizer) {
                    badgeHtml = '<span class="badge-organizer">Arrangör</span>';
                }

                // PIN-kod: Arrangören ser KODEN FÖR ALLA SPELARE!
                // Spelaren ser sin egen kod om det är hans plats.
                let pinBadgeHtml = '';
                if (isUserAdmin && player.pin) {
                    pinBadgeHtml = `<span class="slot-pin-badge" title="Spelarens inloggningskod">PIN: ${player.pin}</span>`;
                } else if (isMe && player.pin) {
                    pinBadgeHtml = `<span class="slot-pin-badge" title="Din personliga inloggningskod">PIN: ${player.pin}</span>`;
                }

                // Arrangörsknappar: Ändra namn (✏️) och Ta bort (✕)
                let adminActionBtns = '';
                if (isUserAdmin) {
                    adminActionBtns = `
                        <button type="button" class="btn-edit-player" data-idx="${i}" title="Byt namn eller ändra PIN för ${escapeHtml(player.name)}">✏️</button>
                        <button type="button" class="btn-remove-player" data-idx="${i}" title="Ta bort ${escapeHtml(player.name)}">✕</button>
                    `;
                }

                row.innerHTML = `
                    <div class="slot-left">
                        <span class="slot-index">${i + 1}</span>
                        <div class="slot-name-wrap">
                            <span class="slot-name">${escapeHtml(player.name)}</span>
                            ${pinBadgeHtml}
                        </div>
                    </div>
                    <div class="slot-badges">
                        ${badgeHtml}
                        ${adminActionBtns}
                    </div>
                `;
            } else {
                let actionBtnHtml = '';
                if (isUserAdmin) {
                    actionBtnHtml = `
                        <button type="button" class="btn-take-slot" data-slot="${i}">
                            + Lägg till spelare
                        </button>
                    `;
                } else if (!appState.currentUser) {
                    actionBtnHtml = `
                        <button type="button" class="btn-take-slot" data-slot="${i}">
                            + Gå med
                        </button>
                    `;
                } else {
                    // Inloggad spelare kan INTE lägga till fler spelare
                    actionBtnHtml = `
                        <span class="slot-waiting-label">Väntar på spelare</span>
                    `;
                }

                row.innerHTML = `
                    <div class="slot-left">
                        <span class="slot-index">${i + 1}</span>
                        <span class="slot-empty-text">Ledig plats</span>
                    </div>
                    ${actionBtnHtml}
                `;
            }
            rosterEl.appendChild(row);
        }

        // Länkdelning: döljs om 8/8 eller lottad
        const inviteStrip = document.getElementById('inviteStrip');
        if (inviteStrip) {
            inviteStrip.style.display = (count >= 8 || tourney.isDrawn) ? 'none' : 'flex';
        }

        // Lottningshandling
        const btnDraw = document.getElementById('btnDrawSchedule');
        const drawnNotice = document.getElementById('drawnStatusNotice');

        if (tourney.isDrawn) {
            if (btnDraw) btnDraw.style.display = 'none';
            if (drawnNotice) drawnNotice.style.display = 'flex';
        } else {
            if (drawnNotice) drawnNotice.style.display = 'none';
            if (btnDraw) {
                btnDraw.style.display = 'block';
                if (isUserAdmin) {
                    if (count === 8) {
                        btnDraw.disabled = false;
                        btnDraw.textContent = '🎲 Lotta spelschema';
                    } else {
                        btnDraw.disabled = true;
                        btnDraw.textContent = `Lotta spelschema (${8 - count} platser kvar)`;
                    }
                } else {
                    btnDraw.disabled = true;
                    btnDraw.textContent = count === 8 
                        ? '8/8 anmälda – arrangören lottar snart' 
                        : `Väntar på 8 spelare (${count}/8)`;
                }
            }
        }
    }

    /**
     * Flik 2: Matcher (med rollbaserat matchfokus)
     */
    function renderMatchesView(tourney) {
        const notDrawnBox = document.getElementById('notDrawnBox');
        const activeContainer = document.getElementById('matchesActiveContainer');

        if (!tourney.isDrawn || !tourney.rounds || tourney.rounds.length === 0) {
            if (notDrawnBox) notDrawnBox.style.display = 'block';
            if (activeContainer) activeContainer.style.display = 'none';
            return;
        }

        if (notDrawnBox) notDrawnBox.style.display = 'none';
        if (activeContainer) activeContainer.style.display = 'flex';

        // Uppdatera omgångspiller
        document.querySelectorAll('.round-pill').forEach((pill, idx) => {
            const isRoundActive = (idx === appState.currentRoundIndex);
            pill.classList.toggle('active', isRoundActive);
            const r = tourney.rounds[idx];
            if (r) {
                const allM = getAllMatchesInRound(r);
                const isRoundDone = allM.length > 0 && allM.every(m => m.completed);
                pill.classList.toggle('completed', isRoundDone);
            }
        });

        const round = tourney.rounds[appState.currentRoundIndex];
        if (!round) return;

        const subContainer = document.getElementById('submatchPickerContainer');
        const partnerBanner = document.getElementById('roundPartnerBanner');
        const partnerText = document.getElementById('roundPartnerText');

        // Hantera delmatcher (Lag-serie 21)
        if (round.subMatches && round.subMatches.length > 0) {
            if (subContainer) subContainer.style.display = 'block';

            document.querySelectorAll('.submatch-pill').forEach(pill => {
                const subIdx = parseInt(pill.dataset.sub, 10);
                const isActive = (subIdx === appState.currentSubMatchIndex);
                pill.classList.toggle('active', isActive);

                const sm = round.subMatches[subIdx];
                const isSubDone = sm && sm.matches && sm.matches.length > 0 && sm.matches.every(m => m.completed);
                pill.classList.toggle('completed', isSubDone);
                pill.textContent = isSubDone ? `Match ${subIdx + 1} ✓` : `Match ${subIdx + 1}`;
            });

            // Visa partner-banner för inloggad spelare
            const currentUserId = appState.currentUser ? appState.currentUser.id : null;
            const currentUserName = appState.currentUser ? appState.currentUser.name : null;

            if (tourney.format === 'court21') {
                const courtInfo = (currentUserId || currentUserName) ? getPlayerCourtInfoForRound(round, currentUserId, currentUserName) : null;
                if (courtInfo && partnerBanner && partnerText) {
                    partnerBanner.style.display = 'flex';
                    const activePartner = courtInfo.partners[appState.currentSubMatchIndex] || 'Partner';
                    partnerText.innerHTML = `Din bana i omgång ${appState.currentRoundIndex + 1}: <strong>Bana ${courtInfo.court}</strong> &nbsp;•&nbsp; Match ${appState.currentSubMatchIndex + 1}-partner: <strong>${escapeHtml(activePartner)}</strong> <span style="opacity: 0.8; font-size: 11px;">(M1: ${escapeHtml(courtInfo.partners[0] || '')}, M2: ${escapeHtml(courtInfo.partners[1] || '')}, M3: ${escapeHtml(courtInfo.partners[2] || '')})</span>`;
                } else if (partnerBanner) {
                    partnerBanner.style.display = 'none';
                }
            } else {
                // Lag-serie 21
                const partner = (currentUserId || currentUserName) ? getRoundPartner(round, currentUserId, currentUserName) : null;

                if (partner && partnerBanner && partnerText) {
                    partnerBanner.style.display = 'flex';
                    partnerText.innerHTML = `Din partner i omgång ${appState.currentRoundIndex + 1} (alla 3 matcher): <strong>${escapeHtml(partner.name)}</strong>`;
                } else if (partnerBanner) {
                    partnerBanner.style.display = 'none';
                }
            }
        } else {
            // Klassisk Americano utan delmatcher
            if (subContainer) subContainer.style.display = 'none';
            if (partnerBanner) partnerBanner.style.display = 'none';
        }

        const currentUserId = appState.currentUser ? appState.currentUser.id : null;
        const currentUserName = appState.currentUser ? (appState.currentUser.name || '').toLowerCase() : '';

        // 4-mannagrupp-etikett för Bana-rotation 21
        const groupLabel1 = document.getElementById('courtGroupLabel1');
        const groupLabel2 = document.getElementById('courtGroupLabel2');
        if (tourney.format === 'court21') {
            const c1Players = getCourtPlayersFromRound(round, 1);
            const c2Players = getCourtPlayersFromRound(round, 2);
            if (groupLabel1) {
                groupLabel1.style.display = c1Players.length > 0 ? 'inline-block' : 'none';
                groupLabel1.textContent = 'Grupp: ' + c1Players.map(p => p.name).join(', ');
                groupLabel1.title = 'Spelare på Bana 1 i denna omgång: ' + c1Players.map(p => p.name).join(', ');
            }
            if (groupLabel2) {
                groupLabel2.style.display = c2Players.length > 0 ? 'inline-block' : 'none';
                groupLabel2.textContent = 'Grupp: ' + c2Players.map(p => p.name).join(', ');
                groupLabel2.title = 'Spelare på Bana 2 i denna omgång: ' + c2Players.map(p => p.name).join(', ');
            }
        } else {
            if (groupLabel1) groupLabel1.style.display = 'none';
            if (groupLabel2) groupLabel2.style.display = 'none';
        }

        // Rendera Bana 1 och Bana 2 för aktiv delmatch
        const courtMatches = [
            getActiveMatchForCourt(round, 0),
            getActiveMatchForCourt(round, 1)
        ];

        courtMatches.forEach((m, cIdx) => {
            if (!m) return;
            const courtNum = cIdx + 1;
            const card = document.getElementById(`courtCard${courtNum}`);
            const statusEl = document.getElementById(`courtStatus${courtNum}`);
            const userTag = document.getElementById(`courtUserTag${courtNum}`);
            const t1Names = document.getElementById(`court${courtNum}Team1Names`);
            const t2Names = document.getElementById(`court${courtNum}Team2Names`);
            const s1Input = document.getElementById(`court${courtNum}Score1`);
            const s2Input = document.getElementById(`court${courtNum}Score2`);
            const row1 = document.getElementById(`court${courtNum}Team1Row`);
            const row2 = document.getElementById(`court${courtNum}Team2Row`);
            const btnSave = document.getElementById(`btnSaveCourt${courtNum}`);
            const lockedLabel = document.getElementById(`courtLockedLabel${courtNum}`);

            const isUserInThisMatch = isCurrentUserInMatch(m);
            const canEdit = canUserEditMatch(m);

            // Framhäv "DIN MATCH"
            if (userTag) {
                userTag.style.display = isUserInThisMatch ? 'inline-block' : 'none';
            }
            if (card) {
                card.classList.toggle('is-my-match', isUserInThisMatch);
                card.classList.toggle('is-other-match', isPlayer() && !isUserInThisMatch);
                card.classList.toggle('completed', m.completed);
            }

            // Formatera lagnamn och markera (Du)
            const formatTeam = (team) => {
                return (team || []).map(p => {
                    const isMe = (currentUserId && p.id === currentUserId) || 
                                 (currentUserName && p.name && p.name.toLowerCase() === currentUserName);
                    return isMe ? `${p.name} (Du)` : p.name;
                }).join(' & ');
            };

            if (t1Names) t1Names.textContent = formatTeam(m.team1);
            if (t2Names) t2Names.textContent = formatTeam(m.team2);

            // Poängsiffror
            if (s1Input && document.activeElement !== s1Input) s1Input.value = m.score1;
            if (s2Input && document.activeElement !== s2Input) s2Input.value = m.score2;

            // Behörigheter för inmatning
            const minusBtns = card.querySelectorAll('.score-minus');
            const plusBtns = card.querySelectorAll('.score-plus');

            if (canEdit) {
                if (s1Input) s1Input.readOnly = false;
                if (s2Input) s2Input.readOnly = false;
                minusBtns.forEach(b => b.style.display = 'flex');
                plusBtns.forEach(b => b.style.display = 'flex');
                if (btnSave) btnSave.style.display = 'block';
                if (lockedLabel) lockedLabel.style.display = 'none';
            } else {
                if (s1Input) s1Input.readOnly = true;
                if (s2Input) s2Input.readOnly = true;
                minusBtns.forEach(b => b.style.display = 'none');
                plusBtns.forEach(b => b.style.display = 'none');
                if (btnSave) btnSave.style.display = 'none';
                if (lockedLabel) {
                    lockedLabel.style.display = 'block';
                    if (isGuest()) {
                        lockedLabel.innerHTML = 'Logga in som spelare eller arrangör för att rapportera resultat.';
                        lockedLabel.style.cursor = 'pointer';
                        lockedLabel.onclick = () => openModal('modalAuth');
                    } else {
                        lockedLabel.textContent = `Parallell match på Bana ${courtNum}`;
                        lockedLabel.style.cursor = 'default';
                        lockedLabel.onclick = null;
                    }
                }
            }

            if (statusEl) statusEl.textContent = m.completed ? '✓ Klar' : 'Pågående';

            if (row1 && row2) {
                row1.classList.toggle('winner', m.completed && m.score1 > m.score2);
                row2.classList.toggle('winner', m.completed && m.score2 > m.score1);
            }
        });
    }

    /**
     * Flik 3: Tabell
     */
    function renderTableView(tourney) {
        const tbody = document.getElementById('leaderboardBody');
        if (!tbody) return;
        tbody.innerHTML = '';

        const leaderboard = calculateLeaderboard(tourney);
        if (leaderboard.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding:24px;color:var(--text-muted);">Inga spelare anmälda än.</td></tr>';
            return;
        }

        const currentUserId = appState.currentUser ? appState.currentUser.id : null;
        const currentUserName = appState.currentUser ? (appState.currentUser.name || '').toLowerCase() : '';

        leaderboard.forEach((item, index) => {
            const tr = document.createElement('tr');
            const isMe = (currentUserId && item.id === currentUserId) || 
                         (currentUserName && item.name.toLowerCase() === currentUserName);

            if (isMe) tr.classList.add('row-current-user');

            let rankClass = '';
            let rankDisplay = index + 1;
            if (index === 0) { rankClass = 'rank-gold'; rankDisplay = '🥇'; }
            else if (index === 1) { rankClass = 'rank-silver'; rankDisplay = '🥈'; }
            else if (index === 2) { rankClass = 'rank-bronze'; rankDisplay = '🥉'; }

            const diffDisplay = item.diff > 0 ? `+${item.diff}` : item.diff;
            const displayName = isMe ? `${escapeHtml(item.name)} <span style="color:var(--primary); font-size:11px;">(Du)</span>` : escapeHtml(item.name);

            tr.innerHTML = `
                <td class="col-rank ${rankClass}">${rankDisplay}</td>
                <td class="col-player">${displayName}</td>
                <td class="col-stat text-center">${item.matchesPlayed}</td>
                <td class="col-stat text-center">${diffDisplay}</td>
                <td class="col-points text-right">${item.totalPoints}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    /**
     * Flik 4: Meny
     */
    function renderMenuView(tourney) {
        const userIcon = document.getElementById('menuUserIcon');
        const userName = document.getElementById('menuUserName');
        const userRole = document.getElementById('menuUserRole');
        const btnLogin = document.getElementById('btnMenuLogin');
        const btnLogout = document.getElementById('btnMenuLogout');
        const adminZone = document.getElementById('menuAdminZone');
        const adminCodeText = document.getElementById('menuAdminCodeText');
        const archiveCount = document.getElementById('menuArchiveCountText');

        if (appState.currentUser) {
            if (isOrganizer()) {
                if (userIcon) userIcon.textContent = '👑';
                if (userName) userName.textContent = appState.currentUser.name;
                if (userRole) userRole.textContent = `Arrangör (Admin) · Kod: ${tourney ? tourney.adminCode : 'PT-00'}`;
            } else {
                if (userIcon) userIcon.textContent = '🎾';
                if (userName) userName.textContent = appState.currentUser.name;
                if (userRole) userRole.textContent = `Spelare · PIN: ${appState.currentUser.pin || 'Saknas'}`;
            }

            if (btnLogin) btnLogin.textContent = 'Byt användare';
            if (btnLogout) btnLogout.style.display = 'inline-flex';
        } else {
            // INGEN STÅR SOM INLOGGAD
            if (userIcon) userIcon.textContent = '👤';
            if (userName) userName.textContent = 'Gästläge';
            if (userRole) userRole.textContent = 'Inte inloggad – Visningsläge';

            if (btnLogin) btnLogin.textContent = 'Logga in';
            if (btnLogout) btnLogout.style.display = 'none';
        }

        // Arrangörsfunktioner visas ENDAST om arrangören är inloggad
        if (adminZone) {
            adminZone.style.display = isOrganizer() ? 'flex' : 'none';
        }
        if (adminCodeText && tourney) {
            adminCodeText.textContent = tourney.adminCode || 'PT-00';
        }

        if (archiveCount) {
            const count = appState.tournaments.length + appState.deletedTournaments.length;
            archiveCount.textContent = `${count} sparade turneringar`;
        }
    }

    // =========================================================================
    // 10. MODALER & NOTIFIERINGAR
    // =========================================================================

    function openModal(modalId) {
        const el = document.getElementById(modalId);
        if (el) el.style.display = 'flex';

        if (modalId === 'modalAuth') {
            setupAuthModalContent();
        }

        playClick();
    }

    function closeModal(modalId) {
        const el = document.getElementById(modalId);
        if (el) el.style.display = 'none';
    }

    function setupAuthModalContent() {
        const tourney = getActiveTournament();
        const playerGrid = document.getElementById('authPlayerGrid');
        const pinGroup = document.getElementById('authPlayerPinGroup');
        const logoutWrap = document.getElementById('authModalLogoutWrap');

        selectedPlayerForLogin = null;
        if (pinGroup) pinGroup.style.display = 'none';
        const pinInput = document.getElementById('authPlayerPinInput');
        if (pinInput) pinInput.value = '';

        if (logoutWrap) {
            logoutWrap.style.display = appState.currentUser ? 'block' : 'none';
        }

        if (!playerGrid) return;
        playerGrid.innerHTML = '';

        if (!tourney || !tourney.players || tourney.players.length === 0) {
            playerGrid.innerHTML = '<span style="font-size:12px;color:var(--text-muted);grid-column:span 2;">Inga spelare är anmälda än.</span>';
            return;
        }

        tourney.players.forEach(p => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'player-select-btn';
            btn.textContent = p.name;
            btn.dataset.playerId = p.id;

            btn.addEventListener('click', () => {
                document.querySelectorAll('.player-select-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                selectedPlayerForLogin = p;

                const nameDisplay = document.getElementById('authSelectedPlayerName');
                if (nameDisplay) nameDisplay.textContent = p.name;
                if (pinGroup) pinGroup.style.display = 'block';
                if (pinInput) {
                    pinInput.focus();
                }
                playClick();
            });

            playerGrid.appendChild(btn);
        });
    }

    function showToast(message) {
        const container = document.getElementById('toastContainer');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerHTML = `<span class="toast-message">${escapeHtml(message)}</span>`;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 3200);
    }

    function showUndoToast(tourney) {
        const container = document.getElementById('toastContainer');
        if (!container) return;
        if (undoToastTimer) clearTimeout(undoToastTimer);

        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.id = 'activeUndoToast';
        toast.innerHTML = `
            <span class="toast-message">🗑️ "${escapeHtml(tourney.name)}" raderades.</span>
            <button type="button" class="toast-btn">Ångra ↺</button>
        `;

        toast.querySelector('.toast-btn').addEventListener('click', () => {
            restoreTournament(tourney.id);
            toast.remove();
        });

        container.appendChild(toast);
        undoToastTimer = setTimeout(() => {
            toast.remove();
        }, 8000);
    }

    function renderArchiveModal() {
        const activeList = document.getElementById('archiveActiveList');
        const trashList = document.getElementById('archiveTrashList');

        if (activeList) {
            activeList.innerHTML = '';
            if (appState.tournaments.length === 0) {
                activeList.innerHTML = '<span style="font-size:12px;color:var(--text-muted);">Inga sparade turneringar</span>';
            } else {
                appState.tournaments.forEach(t => {
                    const item = document.createElement('div');
                    item.className = 'archive-item';
                    item.innerHTML = `
                        <div class="archive-item-info">
                            <div class="archive-item-title">${escapeHtml(t.name)}</div>
                            <div class="archive-item-sub">${new Date(t.createdAt).toLocaleDateString('sv-SE')} · ${t.players.length}/8 spelare</div>
                        </div>
                        <div class="archive-item-actions">
                            <button type="button" class="btn btn-secondary btn-sm select-btn">Öppna</button>
                        </div>
                    `;
                    item.querySelector('.select-btn').addEventListener('click', () => {
                        appState.activeTournamentId = t.id;
                        appState.currentRoundIndex = 0;
                        appState.currentSubMatchIndex = 0;
                        saveState();
                        initCloudSync();
                        renderApp();
                        closeModal('modalArchive');
                        switchView('viewPlayers');
                    });
                    activeList.appendChild(item);
                });
            }
        }

        if (trashList) {
            trashList.innerHTML = '';
            if (appState.deletedTournaments.length === 0) {
                trashList.innerHTML = '<span style="font-size:12px;color:var(--text-muted);">Papperskorgen är tom</span>';
            } else {
                appState.deletedTournaments.forEach(t => {
                    const item = document.createElement('div');
                    item.className = 'archive-item';
                    item.innerHTML = `
                        <div class="archive-item-info">
                            <div class="archive-item-title">${escapeHtml(t.name)}</div>
                            <div class="archive-item-sub">Raderad · ${t.players.length} spelare</div>
                        </div>
                        <div class="archive-item-actions">
                            <button type="button" class="btn btn-secondary btn-sm restore-btn">Återställ</button>
                            <button type="button" class="btn btn-danger-sm perm-del-btn">✕</button>
                        </div>
                    `;
                    item.querySelector('.restore-btn').addEventListener('click', () => {
                        restoreTournament(t.id);
                        renderArchiveModal();
                    });
                    item.querySelector('.perm-del-btn').addEventListener('click', () => {
                        if (confirm(`Radera "${t.name}" permanent?`)) {
                            deleteTournament(t.id, true);
                        }
                    });
                    trashList.appendChild(item);
                });
            }
        }
    }

    // =========================================================================
    // 11. NAVIGERING MELLAN FLIKAR
    // =========================================================================

    function switchView(viewId) {
        document.querySelectorAll('.nav-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === viewId);
        });

        document.querySelectorAll('.app-view').forEach(view => {
            if (view.id === viewId) {
                view.style.display = 'block';
                view.classList.add('active');
            } else {
                view.style.display = 'none';
                view.classList.remove('active');
            }
        });

        playClick();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // =========================================================================
    // 12. HÄNDELSELYSSNARE (EVENT LISTENERS)
    // =========================================================================

    function setupEventListeners() {
        // Bottenmeny
        document.querySelectorAll('.nav-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                switchView(btn.dataset.tab);
            });
        });

        // Omgångsväljare
        document.querySelectorAll('.round-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                appState.currentRoundIndex = parseInt(pill.dataset.round, 10);
                appState.currentSubMatchIndex = 0; // Återställ alltid till match 1 vid ny omgång
                const tourney = getActiveTournament();
                if (tourney) renderMatchesView(tourney);
                playClick();
            });
        });

        // Delmatchväljare (Match 1, Match 2, Match 3 i Lag-serie 21)
        document.querySelectorAll('.submatch-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                appState.currentSubMatchIndex = parseInt(pill.dataset.sub, 10) || 0;
                const tourney = getActiveTournament();
                if (tourney) renderMatchesView(tourney);
                playClick();
            });
        });

        // Startskärm knappar
        document.getElementById('btnStartCreate').addEventListener('click', () => openModal('modalNewTourney'));
        document.getElementById('btnStartArchive').addEventListener('click', () => {
            renderArchiveModal();
            openModal('modalArchive');
        });

        // Meny knappar
        document.getElementById('btnMenuNewTourney').addEventListener('click', () => openModal('modalNewTourney'));
        document.getElementById('btnMenuLogin').addEventListener('click', () => openModal('modalAuth'));
        document.getElementById('btnMenuLogout').addEventListener('click', logoutUser);
        document.getElementById('btnUserHeader').addEventListener('click', () => openModal('modalAuth'));
        document.getElementById('btnOpenArchiveModal').addEventListener('click', () => {
            renderArchiveModal();
            openModal('modalArchive');
        });

        document.getElementById('btnMenuDeleteTourney').addEventListener('click', () => {
            const active = getActiveTournament();
            if (active && confirm(`Vill du flytta turneringen "${active.name}" till papperskorgen?`)) {
                deleteTournament(active.id);
            }
        });

        // Inbjudan & Länkdelning
        const copyInviteHandler = () => {
            const active = getActiveTournament();
            if (!active) return;
            const message = getInviteShareMessage(active);
            navigator.clipboard.writeText(message).then(() => {
                showToast('📋 Inbjudan kopierad till urklipp!');
                playSuccess();
            }).catch(() => {
                prompt('Kopiera inbjudan här:', message);
            });
        };

        const copyAdminLinkHandler = () => {
            const active = getActiveTournament();
            if (!active) return;
            const url = getShareableUrl(active, true);
            navigator.clipboard.writeText(url).then(() => {
                showToast('🔑 Arrangörslänk med full behörighet kopierad!');
                playSuccess();
            }).catch(() => {
                prompt('Kopiera arrangörslänken här:', url);
            });
        };

        const whatsappInviteHandler = () => {
            const active = getActiveTournament();
            if (!active) return;
            const message = getInviteShareMessage(active);
            const text = encodeURIComponent(message);
            window.open(`https://wa.me/?text=${text}`, '_blank');
        };

        function fallbackCopyText(text, successToastMsg) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try {
                document.execCommand('copy');
                showToast(successToastMsg || '✓ Kopierat!');
                playSuccess();
            } catch (e) {
                prompt('Kopiera texten här:', text);
            }
            document.body.removeChild(ta);
        }

        const copySummaryReportHandler = () => {
            const active = getActiveTournament();
            if (!active) {
                showToast('Ingen aktiv turnering att exportera.');
                return;
            }
            const message = getTournamentSummaryReport(active);
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(message).then(() => {
                    showToast('📋 Resultatrapport kopierad till urklipp!');
                    playSuccess();
                }).catch(() => {
                    fallbackCopyText(message, '📋 Resultatrapport kopierad!');
                });
            } else {
                fallbackCopyText(message, '📋 Resultatrapport kopierad!');
            }
        };

        const whatsappSummaryReportHandler = () => {
            const active = getActiveTournament();
            if (!active) {
                showToast('Ingen aktiv turnering att dela.');
                return;
            }
            const message = getTournamentSummaryReport(active);
            const text = encodeURIComponent(message);
            window.open(`https://wa.me/?text=${text}`, '_blank');
        };

        document.getElementById('btnCopyInviteLink').addEventListener('click', copyInviteHandler);
        document.getElementById('btnMenuCopyLink').addEventListener('click', copyInviteHandler);
        document.getElementById('btnCopyAdminLink').addEventListener('click', copyAdminLinkHandler);
        document.getElementById('btnWhatsappInvite').addEventListener('click', whatsappInviteHandler);
        document.getElementById('btnMenuWhatsapp').addEventListener('click', whatsappInviteHandler);

        // Resultatrapport-knappar (Tabellfliken och Menyn)
        const btnCopyReportTable = document.getElementById('btnCopyReportTable');
        if (btnCopyReportTable) btnCopyReportTable.addEventListener('click', copySummaryReportHandler);

        const btnWhatsappReportTable = document.getElementById('btnWhatsappReportTable');
        if (btnWhatsappReportTable) btnWhatsappReportTable.addEventListener('click', whatsappSummaryReportHandler);

        const btnMenuCopyReport = document.getElementById('btnMenuCopyReport');
        if (btnMenuCopyReport) btnMenuCopyReport.addEventListener('click', copySummaryReportHandler);

        const btnMenuWhatsappReport = document.getElementById('btnMenuWhatsappReport');
        if (btnMenuWhatsappReport) btnMenuWhatsappReport.addEventListener('click', whatsappSummaryReportHandler);

        // Lottningsknapp
        document.getElementById('btnDrawSchedule').addEventListener('click', () => {
            const tourney = getActiveTournament();
            if (tourney) drawSchedule(tourney);
        });

        document.getElementById('btnJumpToMatches').addEventListener('click', () => {
            switchView('viewMatches');
        });

        const btnGoMatches = document.getElementById('btnGoToPlayersFromMatches');
        if (btnGoMatches) {
            btnGoMatches.addEventListener('click', () => switchView('viewPlayers'));
        }

        // Ta plats, Ändra namn & Ta bort klick i spelarlistan
        document.getElementById('rosterList').addEventListener('click', (e) => {
            const takeBtn = e.target.closest('.btn-take-slot');
            if (takeBtn) {
                if (isPlayer()) {
                    alert('Endast en inloggad arrangör kan lägga till fler spelare.');
                    return;
                }
                const slot = takeBtn.dataset.slot;
                openTakeSlotModal(slot);
                return;
            }

            const editBtn = e.target.closest('.btn-edit-player');
            if (editBtn) {
                const idx = parseInt(editBtn.dataset.idx, 10);
                openEditPlayerModal(idx);
                return;
            }

            const removeBtn = e.target.closest('.btn-remove-player');
            if (removeBtn) {
                const idx = parseInt(removeBtn.dataset.idx, 10);
                const tourney = getActiveTournament();
                if (tourney) removePlayer(tourney, idx);
                return;
            }
        });

        // Spara poäng knappar
        document.querySelectorAll('.btn-save-score').forEach(btn => {
            btn.addEventListener('click', () => {
                const court = parseInt(btn.dataset.court, 10);
                saveMatchScore(court);
            });
        });

        // Poängstegare (+ / -)
        document.querySelectorAll('.score-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const court = btn.dataset.court;
                const team = btn.dataset.team;
                const isPlus = btn.classList.contains('score-plus');
                const input = document.getElementById(`court${parseInt(court, 10) + 1}Score${team}`);
                if (input && !input.readOnly) {
                    let val = parseInt(input.value, 10) || 0;
                    val = isPlus ? val + 1 : Math.max(0, val - 1);
                    input.value = val;
                    playClick();
                }
            });
        });

        // Modal stängningar (kryssknapp & klick på bakgrunden)
        document.querySelectorAll('.btn-close-modal').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal-overlay');
                if (modal) modal.style.display = 'none';
            });
        });

        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    overlay.style.display = 'none';
                }
            });
        });

        document.getElementById('btnClosePinConfirm').addEventListener('click', () => {
            closeModal('modalPinConfirm');
        });

        const copyPinConfirmBtn = document.getElementById('btnCopyPinConfirm');
        if (copyPinConfirmBtn) {
            copyPinConfirmBtn.addEventListener('click', () => {
                const code = (document.getElementById('pinConfirmCode').textContent || '').trim();
                if (code && code !== '0000') {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(code).then(() => {
                            const orig = copyPinConfirmBtn.textContent;
                            copyPinConfirmBtn.textContent = '✓ Koden kopierades!';
                            setTimeout(() => { copyPinConfirmBtn.textContent = orig; }, 2000);
                            showToast(`📋 PIN-koden (${code}) kopierades!`);
                        }).catch(() => {
                            prompt('Kopiera din kod:', code);
                        });
                    } else {
                        prompt('Kopiera din kod:', code);
                    }
                }
            });
        }

        document.getElementById('btnEmptyTrash').addEventListener('click', () => {
            if (confirm('Vill du tömma papperskorgen permanent? Detta kan inte ångras.')) {
                appState.deletedTournaments = [];
                saveState();
                renderArchiveModal();
                playDelete();
            }
        });

        // Formulär: Skapa ny turnering
        document.getElementById('formNewTourney').addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('newTourneyName').value;
            const org = document.getElementById('newTourneyOrg').value;
            const plays = document.getElementById('newTourneyOrgPlays').checked;
            const format = document.getElementById('newTourneyFormat').value;
            const points = document.getElementById('newTourneyPoints').value;

            createNewTournament(name, org, plays, format, points);
            closeModal('modalNewTourney');
            e.target.reset();
        });

        // Formulär: Ta plats
        document.getElementById('formTakeSlot').addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('takeSlotPlayerName').value;
            const slot = document.getElementById('takeSlotIndex').value;
            const tourney = getActiveTournament();
            if (tourney && name) {
                const ok = registerPlayer(tourney, name, slot);
                if (ok) {
                    closeModal('modalTakeSlot');
                    e.target.reset();
                }
            }
        });

        // Formulär: Ändra / byt namn på spelare (Arrangör)
        document.getElementById('formEditPlayer').addEventListener('submit', (e) => {
            e.preventDefault();
            const idx = parseInt(document.getElementById('editPlayerIndex').value, 10);
            const newName = document.getElementById('editPlayerNameInput').value;
            const newPin = document.getElementById('editPlayerPinInput').value;
            saveEditedPlayer(idx, newName, newPin);
        });

        // Knapp: Ta bort spelare inifrån ändra-modalen
        document.getElementById('btnDeletePlayerFromModal').addEventListener('click', () => {
            const idx = parseInt(document.getElementById('editPlayerIndex').value, 10);
            const tourney = getActiveTournament();
            if (tourney && !isNaN(idx)) {
                closeModal('modalEditPlayer');
                removePlayer(tourney, idx);
            }
        });

        // =====================================================================
        // AUTH MODAL LOGIK: SPELARE VS ARRANGÖR
        // =====================================================================

        const tabBtnPlayer = document.getElementById('authTabBtnPlayer');
        const tabBtnAdmin = document.getElementById('authTabBtnAdmin');
        const secPlayer = document.getElementById('authSectionPlayer');
        const secAdmin = document.getElementById('authSectionAdmin');

        if (tabBtnPlayer && tabBtnAdmin) {
            tabBtnPlayer.addEventListener('click', () => {
                tabBtnPlayer.classList.add('active');
                tabBtnAdmin.classList.remove('active');
                if (secPlayer) secPlayer.style.display = 'block';
                if (secAdmin) secAdmin.style.display = 'none';
                playClick();
            });

            tabBtnAdmin.addEventListener('click', () => {
                tabBtnAdmin.classList.add('active');
                tabBtnPlayer.classList.remove('active');
                if (secAdmin) secAdmin.style.display = 'block';
                if (secPlayer) secPlayer.style.display = 'none';
                playClick();
            });
        }

        // Spelarinloggning med vald spelare + PIN
        document.getElementById('btnSubmitPlayerLogin').addEventListener('click', () => {
            if (!selectedPlayerForLogin) {
                alert('Välj först ditt namn i listan.');
                return;
            }

            const pinInput = document.getElementById('authPlayerPinInput');
            const enteredPin = (pinInput ? pinInput.value : '').trim();

            if (!enteredPin) {
                alert('Ange din 4-siffriga PIN-kod.');
                return;
            }

            if (selectedPlayerForLogin.pin && selectedPlayerForLogin.pin.toString() === enteredPin) {
                appState.currentUser = {
                    id: selectedPlayerForLogin.id,
                    name: selectedPlayerForLogin.name,
                    pin: selectedPlayerForLogin.pin,
                    role: 'player'
                };
                sessionStorage.removeItem(LOGOUT_FLAG_KEY);
                saveUser();
                closeModal('modalAuth');
                renderApp();
                playSuccess();
                showToast(`🎾 Välkommen, ${selectedPlayerForLogin.name}!`);
            } else {
                alert(`Felaktig PIN-kod för ${selectedPlayerForLogin.name}. Kontrollera koden och försök igen.`);
                if (pinInput) {
                    pinInput.value = '';
                    pinInput.focus();
                }
            }
        });

        // Arrangörsinloggning med PT-xx eller nyckel
        document.getElementById('formAdminAuth').addEventListener('submit', (e) => {
            e.preventDefault();
            const code = document.getElementById('authAdminCodeInput').value.trim();
            const tourney = getActiveTournament();

            if (!tourney) {
                alert('Ingen aktiv turnering är vald.');
                return;
            }

            const isUlrik = code.toLowerCase() === 'ulrik';
            const isEje = code.toLowerCase() === 'eje';
            const isMaster = isUlrik || isEje;
            const matchesCode = tourney.adminCode && code.toUpperCase() === tourney.adminCode.toUpperCase();
            const matchesKey = tourney.adminKey && code === tourney.adminKey;

            if (isMaster || matchesCode || matchesKey) {
                const adminName = isEje ? 'Eje' : (isUlrik ? 'Ulrik' : ((tourney.organizer && tourney.organizer.name) ? tourney.organizer.name : 'Arrangör'));
                appState.currentUser = {
                    id: (tourney.organizer && tourney.organizer.id) ? tourney.organizer.id : 'org_' + tourney.id,
                    name: adminName,
                    role: 'admin',
                    tourneyKey: tourney.adminKey
                };
                saveUser();
                saveAdminKeyForTourney(tourney.id, tourney.adminKey);
                closeModal('modalAuth');
                renderApp();
                playSuccess();
                showToast(`👑 Inloggad som Arrangör (${appState.currentUser.name})`);
                e.target.reset();
            } else {
                alert('Felaktig arrangörskod. Ange koden som skapades med turneringen (t.ex. PT-xx).');
            }
        });

        // Logga ut inifrån modalen
        document.getElementById('btnModalLogout').addEventListener('click', () => {
            closeModal('modalAuth');
            logoutUser();
        });

        // =====================================================================
        // INBJUDNINGSMODAL (GÅ MED, SKRIV NAMN & FÅ KOD)
        // =====================================================================

        const btnInviteAccept = document.getElementById('btnInviteAccept');
        if (btnInviteAccept) {
            btnInviteAccept.addEventListener('click', () => {
                const askStep = document.getElementById('inviteStepAsk');
                const nameStep = document.getElementById('inviteStepName');
                const nameInput = document.getElementById('inviteJoinPlayerName');
                if (askStep) askStep.style.display = 'none';
                if (nameStep) nameStep.style.display = 'block';
                if (nameInput) setTimeout(() => nameInput.focus(), 100);
                playClick();
            });
        }

        const btnInviteDecline = document.getElementById('btnInviteDecline');
        if (btnInviteDecline) {
            btnInviteDecline.addEventListener('click', () => {
                const tourney = getActiveTournament();
                if (tourney) sessionStorage.setItem(`pinta_declined_invite_${tourney.id}`, 'true');
                closeModal('modalInviteJoin');
                playClick();
            });
        }

        const btnCloseInviteStepAsk = document.getElementById('btnCloseInviteStepAsk');
        if (btnCloseInviteStepAsk) {
            btnCloseInviteStepAsk.addEventListener('click', () => {
                const tourney = getActiveTournament();
                if (tourney) sessionStorage.setItem(`pinta_declined_invite_${tourney.id}`, 'true');
                closeModal('modalInviteJoin');
            });
        }

        const btnCloseInviteStepName = document.getElementById('btnCloseInviteStepName');
        if (btnCloseInviteStepName) {
            btnCloseInviteStepName.addEventListener('click', () => closeModal('modalInviteJoin'));
        }

        const btnInviteBackToAsk = document.getElementById('btnInviteBackToAsk');
        if (btnInviteBackToAsk) {
            btnInviteBackToAsk.addEventListener('click', () => {
                const askStep = document.getElementById('inviteStepAsk');
                const nameStep = document.getElementById('inviteStepName');
                if (askStep) askStep.style.display = 'block';
                if (nameStep) nameStep.style.display = 'none';
                playClick();
            });
        }

        const btnInviteOpenLogin = document.getElementById('btnInviteOpenLogin');
        if (btnInviteOpenLogin) {
            btnInviteOpenLogin.addEventListener('click', () => {
                closeModal('modalInviteJoin');
                openModal('modalAuth');
            });
        }

        const formInviteJoinName = document.getElementById('formInviteJoinName');
        if (formInviteJoinName) {
            formInviteJoinName.addEventListener('submit', (e) => {
                e.preventDefault();
                const tourney = getActiveTournament();
                if (!tourney) return;
                const input = document.getElementById('inviteJoinPlayerName');
                const name = input ? input.value.trim() : '';
                if (!name) return;
                const nextSlot = (tourney.players || []).length;
                registerPlayer(tourney, name, nextSlot);
            });
        }
    }

    // =========================================================================
    // 13. INITIERING
    // =========================================================================

    function init() {
        initFirebase();
        loadState();
        setupEventListeners();
        renderApp();
        initCloudSync();

        // Standardvy: Spelare om turnering finns, annars Startskärm
        if (getActiveTournament()) {
            switchView('viewPlayers');
        }

        // Hämta färsk version direkt från molnet om turnering är aktiv
        if (appState.activeTournamentId && db) {
            db.collection('tournaments').doc(appState.activeTournamentId).get().then(doc => {
                if (doc.exists) {
                    const cloudTourney = doc.data();
                    const idx = appState.tournaments.findIndex(t => t.id === appState.activeTournamentId);
                    if (idx >= 0) {
                        appState.tournaments[idx] = cloudTourney;
                    } else {
                        appState.tournaments.push(cloudTourney);
                    }
                    saveState(true);
                    renderApp();
                }
            }).catch(e => console.warn('Kunde inte läsa aktiv turnering vid start:', e));
        }

        setTimeout(checkAutoInvitePrompt, 350);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
