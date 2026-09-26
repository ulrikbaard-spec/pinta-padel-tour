/**
 * PINTA PADEL TOUR – HUVUDAPPLIKATION
 * Inbjudningslänkar, inloggning (Arrangör vs Spelare), papperskorg & återställning av turneringar, manuell lottning & realtidssynk
 */

(function () {
    'use strict';

    // =========================================================================
    // 1. STATE & KONFIGURATION
    // =========================================================================

    const STORAGE_KEY = 'pinta_padel_data_v2';
    const AUTH_KEY = 'pinta_padel_user_v2';
    const PLAYERS_KEY = 'pinta_padel_registered_players_v2';
    const ADMIN_KEYS_KEY = 'pinta_padel_admin_keys_v2';

    let appState = {
        currentUser: null,           // { id, name, pin, role: 'admin'|'player' }
        activeTournamentId: null,
        tournaments: [],             // Aktiva turneringar
        deletedTournaments: [],      // Papperskorg (kan återställas!)
        registeredPlayers: [],       // Spelarregister (alla registrerade deltagare)
        cloudConnected: false
    };

    /**
     * Smart arrangörsidentifiering:
     * - Skaparen har admin-nyckeln sparad i localStorage (ingen PIN-kod behövs).
     * - På andra enheter kan arrangören låsa upp via arrangörslänk (?key=...) eller arrangörskod (PT-xx).
     */
    function getAdminKeys() {
        try {
            const raw = localStorage.getItem(ADMIN_KEYS_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }

    function saveAdminKeyForTourney(tourneyId, key) {
        if (!tourneyId || !key) return;
        try {
            const keys = getAdminKeys();
            keys[tourneyId] = key;
            localStorage.setItem(ADMIN_KEYS_KEY, JSON.stringify(keys));
        } catch (e) {
            console.error('Kunde inte spara adminnyckel:', e);
        }
    }

    function isUserOrganizerOf(tourney) {
        if (!tourney) return false;
        // 1. Har denna webbläsare sparad adminnyckel för turneringen?
        const keys = getAdminKeys();
        if (tourney.adminKey && keys[tourney.id] === tourney.adminKey) {
            return true;
        }
        // 2. Har inloggad användare admin-roll och matchande namn/nyckel?
        if (appState.currentUser && appState.currentUser.role === 'admin') {
            if (tourney.organizer && tourney.organizer.name && appState.currentUser.name) {
                if (tourney.organizer.name.toLowerCase() === appState.currentUser.name.toLowerCase()) {
                    return true;
                }
            }
            if (tourney.adminKey && appState.currentUser.tourneyKey === tourney.adminKey) {
                return true;
            }
        }
        return false;
    }

    let currentSelectedRound = 0;
    let currentEditingMatch = null;
    let mqttClient = null;
    let broadcastChannel = null;
    let undoToastTimer = null;

    // =========================================================================
    // 2. TURNERINGSGENERATORER (LOTTNING & SPELORDNING FÖR 8 SPELARE)
    // =========================================================================

    /**
     * Alternativ 1: Lag-serie
     * 7 omgångar. I varje omgång bildas 4 lag (2 spelare i varje).
     * De 4 lagen möter varandra i ett seriespel (3 matcher per lag, 6 matcher totalt per omgång).
     * Nästa omgång byter man partner så att alla spelar en omgång med varje medspelare (21 matcher per spelare).
     */
    function generateScheduleOption1(playerNames) {
        const rounds = [];

        // Round-robin 1-faktorisering av K8 för 8 spelare (index 0..7)
        // Spelare 7 hålls fast, 0..6 roterar
        for (let r = 0; r < 7; r++) {
            const p1 = [7, r];
            const p2 = [(r + 1) % 7, (r + 6) % 7];
            const p3 = [(r + 2) % 7, (r + 5) % 7];
            const p4 = [(r + 3) % 7, (r + 4) % 7];

            const teams = [
                { id: `R${r}_T1`, name: `Lag 1`, players: [playerNames[p1[0]], playerNames[p1[1]]] },
                { id: `R${r}_T2`, name: `Lag 2`, players: [playerNames[p2[0]], playerNames[p2[1]]] },
                { id: `R${r}_T3`, name: `Lag 3`, players: [playerNames[p3[0]], playerNames[p3[1]]] },
                { id: `R${r}_T4`, name: `Lag 4`, players: [playerNames[p4[0]], playerNames[p4[1]]] }
            ];

            const matches = [
                createMatch(r, 1, 1, teams[0], teams[1], 'Matchomgång 1'),
                createMatch(r, 1, 2, teams[2], teams[3], 'Matchomgång 1'),
                
                createMatch(r, 2, 1, teams[0], teams[2], 'Matchomgång 2'),
                createMatch(r, 2, 2, teams[1], teams[3], 'Matchomgång 2'),
                
                createMatch(r, 3, 1, teams[0], teams[3], 'Matchomgång 3'),
                createMatch(r, 3, 2, teams[1], teams[2], 'Matchomgång 3')
            ];

            rounds.push({
                roundNumber: r + 1,
                name: `Omgång ${r + 1}`,
                teams: teams,
                matches: matches
            });
        }

        return rounds;
    }

    /**
     * Alternativ 2: Bana-rotation
     * 7 omgångar. Samma 4 spelar på samma bana hela omgången.
     * På banan spelas 3 matcher så att man spelar en match med varje annan spelare på banan.
     */
    function generateScheduleOption2(playerNames) {
        const fanoLines = [
            [0, 1, 3],
            [1, 2, 4],
            [2, 3, 5],
            [3, 4, 6],
            [4, 5, 0],
            [5, 6, 1],
            [6, 0, 2]
        ];

        const rounds = [];

        for (let r = 0; r < 7; r++) {
            const line = fanoLines[r];
            const court1Indices = [7, line[0], line[1], line[2]];
            const court2Indices = [0, 1, 2, 3, 4, 5, 6].filter(idx => !line.includes(idx));

            const c1Players = court1Indices.map(i => playerNames[i]);
            const c2Players = court2Indices.map(i => playerNames[i]);

            // På Bana 1 (A, B, C, D):
            const court1Matches = [
                createMatch(r, 1, 1, 
                    { id: `R${r}_C1M1_T1`, name: 'Lag 1', players: [c1Players[0], c1Players[1]] },
                    { id: `R${r}_C1M1_T2`, name: 'Lag 2', players: [c1Players[2], c1Players[3]] },
                    'Match 1'
                ),
                createMatch(r, 2, 1, 
                    { id: `R${r}_C1M2_T1`, name: 'Lag 1', players: [c1Players[0], c1Players[2]] },
                    { id: `R${r}_C1M2_T2`, name: 'Lag 2', players: [c1Players[1], c1Players[3]] },
                    'Match 2'
                ),
                createMatch(r, 3, 1, 
                    { id: `R${r}_C1M3_T1`, name: 'Lag 1', players: [c1Players[0], c1Players[3]] },
                    { id: `R${r}_C1M3_T2`, name: 'Lag 2', players: [c1Players[1], c1Players[2]] },
                    'Match 3'
                )
            ];

            // På Bana 2 (E, F, G, H):
            const court2Matches = [
                createMatch(r, 1, 2, 
                    { id: `R${r}_C2M1_T1`, name: 'Lag 1', players: [c2Players[0], c2Players[1]] },
                    { id: `R${r}_C2M1_T2`, name: 'Lag 2', players: [c2Players[2], c2Players[3]] },
                    'Match 1'
                ),
                createMatch(r, 2, 2, 
                    { id: `R${r}_C2M2_T1`, name: 'Lag 1', players: [c2Players[0], c2Players[2]] },
                    { id: `R${r}_C2M2_T2`, name: 'Lag 2', players: [c2Players[1], c2Players[3]] },
                    'Match 2'
                ),
                createMatch(r, 3, 2, 
                    { id: `R${r}_C2M3_T1`, name: 'Lag 1', players: [c2Players[0], c2Players[3]] },
                    { id: `R${r}_C2M3_T2`, name: 'Lag 2', players: [c2Players[1], c2Players[2]] },
                    'Match 3'
                )
            ];

            rounds.push({
                roundNumber: r + 1,
                name: `Omgång ${r + 1}`,
                court1Players: c1Players,
                court2Players: c2Players,
                matches: [
                    court1Matches[0], court2Matches[0],
                    court1Matches[1], court2Matches[1],
                    court1Matches[2], court2Matches[2]
                ]
            });
        }

        return rounds;
    }

    function createMatch(roundIndex, slotIndex, courtIndex, team1, team2, slotLabel) {
        return {
            id: `m_${roundIndex}_${slotIndex}_${courtIndex}`,
            roundIndex: roundIndex,
            slotIndex: slotIndex,
            courtIndex: courtIndex,
            slotLabel: slotLabel,
            team1: team1,
            team2: team2,
            score1: null,
            score2: null,
            completed: false,
            updatedAt: null
        };
    }

    /**
     * Manuell Lottning som anropas via lottningsknappen
     */
    function executeDraw(tourney) {
        if (!tourney || !tourney.players || tourney.players.length !== 8) {
            alert('Det krävs exakt 8 spelare för att kunna genomföra lottningen.');
            return false;
        }

        // Slumpa spelarnas ordning (Fisher-Yates) så att lottningen blir helt rättvis och slumpmässig
        for (let i = tourney.players.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [tourney.players[i], tourney.players[j]] = [tourney.players[j], tourney.players[i]];
        }

        const playerNames = tourney.players.map(p => (typeof p === 'string' ? p : p.name));

        if (tourney.format === 'option1') {
            tourney.rounds = generateScheduleOption1(playerNames);
        } else {
            tourney.rounds = generateScheduleOption2(playerNames);
        }

        tourney.status = 'active';
        tourney.drawnAt = new Date().toISOString();

        playFanfare();
        startConfetti();
        showDrawCelebrationBanner();

        saveState();
        renderApp();
        switchTab('tabMatches');
        return true;
    }

    // =========================================================================
    // 3. TABELL & STATISTIK (LEADERBOARD)
    // =========================================================================

    function calculateLeaderboard(tournament) {
        if (!tournament || !tournament.players || tournament.players.length === 0) return [];

        const stats = {};
        tournament.players.forEach(p => {
            const pName = typeof p === 'string' ? p : p.name;
            stats[pName] = {
                name: pName,
                matchesPlayed: 0,
                wins: 0,
                losses: 0,
                draws: 0,
                pointsScored: 0,
                pointsConceded: 0,
                pointDiff: 0,
                totalPoints: 0
            };
        });

        if (tournament.rounds && tournament.rounds.length > 0) {
            tournament.rounds.forEach(round => {
                (round.matches || []).forEach(m => {
                    if (m.completed && m.score1 !== null && m.score2 !== null) {
                        const s1 = parseInt(m.score1, 10);
                        const s2 = parseInt(m.score2, 10);

                        // Lag 1
                        m.team1.players.forEach(pName => {
                            if (stats[pName]) {
                                stats[pName].matchesPlayed += 1;
                                stats[pName].pointsScored += s1;
                                stats[pName].pointsConceded += s2;
                                stats[pName].pointDiff += (s1 - s2);
                                stats[pName].totalPoints += s1;

                                if (s1 > s2) stats[pName].wins += 1;
                                else if (s2 > s1) stats[pName].losses += 1;
                                else stats[pName].draws += 1;
                            }
                        });

                        // Lag 2
                        m.team2.players.forEach(pName => {
                            if (stats[pName]) {
                                stats[pName].matchesPlayed += 1;
                                stats[pName].pointsScored += s2;
                                stats[pName].pointsConceded += s1;
                                stats[pName].pointDiff += (s2 - s1);
                                stats[pName].totalPoints += s2;

                                if (s2 > s1) stats[pName].wins += 1;
                                else if (s1 > s2) stats[pName].losses += 1;
                                else stats[pName].draws += 1;
                            }
                        });
                    }
                });
            });
        }

        const leaderboard = Object.values(stats);
        leaderboard.sort((a, b) => {
            if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
            if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;
            if (b.wins !== a.wins) return b.wins - a.wins;
            return b.pointsScored - a.pointsScored;
        });

        return leaderboard;
    }

    // =========================================================================
    // 4. STORAGE & SYNC (LOKALT, BROKER & URL-PAYLOAD)
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
            console.error('Kunde inte läsa från localStorage:', e);
        }

        // Säkerställ att varje turnering har adminKey, adminCode och organizer
        const currentAdminKeys = getAdminKeys();
        let keysNeedSave = false;
        (appState.tournaments || []).forEach(t => {
            if (!t.adminKey) {
                t.adminKey = 'adm_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
            }
            if (!t.adminCode) {
                t.adminCode = 'PT-' + Math.floor(10 + Math.random() * 90);
            }
            if (!t.organizer) {
                t.organizer = {
                    id: 'org_' + (t.id || 'default'),
                    name: 'Ulrik'
                };
            }
            // Säkerställ att spelare i turneringen har 4-siffrig PIN
            (t.players || []).forEach((p, idx) => {
                if (typeof p === 'object' && !p.pin) {
                    p.pin = Math.floor(1000 + Math.random() * 9000).toString();
                }
            });
            // Om turneringen finns lokalt men nyckeln saknas i nyckelregistret, spara den
            if (!currentAdminKeys[t.id]) {
                currentAdminKeys[t.id] = t.adminKey;
                keysNeedSave = true;
            }
        });
        if (keysNeedSave) {
            try {
                localStorage.setItem(ADMIN_KEYS_KEY, JSON.stringify(currentAdminKeys));
            } catch (e) {}
        }

        // Läs in spelarregistret (registrerade spelare)
        try {
            const regRaw = localStorage.getItem(PLAYERS_KEY);
            if (regRaw) {
                appState.registeredPlayers = JSON.parse(regRaw);
                // Säkerställ att varje spelare har en 4-siffrig PIN
                let updatedPins = false;
                appState.registeredPlayers.forEach(rp => {
                    if (!rp.pin) {
                        rp.pin = Math.floor(1000 + Math.random() * 9000).toString();
                        updatedPins = true;
                    }
                });
                if (updatedPins) saveRegisteredPlayers();
            } else {
                // Samla befintliga spelare från turneringar om registret är tomt
                const existingMap = new Map();
                (appState.tournaments || []).forEach(t => {
                    (t.players || []).forEach(p => {
                        const name = typeof p === 'string' ? p : p.name;
                        const pin = (typeof p === 'object' && p.pin) ? p.pin : Math.floor(1000 + Math.random() * 9000).toString();
                        if (name && !existingMap.has(name.toLowerCase())) {
                            existingMap.set(name.toLowerCase(), {
                                id: (typeof p === 'object' && p.id) ? p.id : ('p_' + Math.random().toString(36).substr(2, 6)),
                                name: name,
                                pin: pin,
                                registeredAt: new Date().toISOString()
                            });
                        }
                    });
                });
                appState.registeredPlayers = Array.from(existingMap.values());
                saveRegisteredPlayers();
            }
        } catch (e) {
            console.error('Kunde inte läsa registrerade spelare:', e);
            appState.registeredPlayers = [];
        }

        // Inloggad användare: standard är GÄSTLÄGE (null) så besökare kan titta utan inloggning
        try {
            const userRaw = localStorage.getItem(AUTH_KEY);
            if (userRaw) {
                appState.currentUser = JSON.parse(userRaw);
            } else {
                appState.currentUser = null; // Gästläge som standard
            }
        } catch (e) {
            console.error('Kunde inte läsa användare:', e);
            appState.currentUser = null;
        }

        // Om skaparen besöker sin egen turnering på denna enhet: känn igen som arrangör automatiskt!
        const activeT = appState.tournaments.find(t => t.id === appState.activeTournamentId) || (appState.tournaments[0] || null);
        if (activeT && isUserOrganizerOf(activeT)) {
            if (!appState.currentUser) {
                appState.currentUser = {
                    id: (activeT.organizer && activeT.organizer.id) ? activeT.organizer.id : 'org_creator',
                    name: (activeT.organizer && activeT.organizer.name) ? activeT.organizer.name : 'Arrangör',
                    role: 'admin',
                    tourneyKey: activeT.adminKey
                };
                saveUser();
            } else if (appState.currentUser.role !== 'admin' && activeT.organizer && activeT.organizer.name && appState.currentUser.name.toLowerCase() === activeT.organizer.name.toLowerCase()) {
                appState.currentUser.role = 'admin';
                saveUser();
            }
        }

        checkUrlForSharedTournament();
    }

    function saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                tournaments: appState.tournaments,
                deletedTournaments: appState.deletedTournaments,
                activeTournamentId: appState.activeTournamentId
            }));

            broadcastLocalUpdate();
            syncToCloud();
        } catch (e) {
            console.error('Kunde inte spara till localStorage:', e);
        }
    }

    function saveRegisteredPlayers() {
        try {
            localStorage.setItem(PLAYERS_KEY, JSON.stringify(appState.registeredPlayers || []));
        } catch (e) {
            console.error('Kunde inte spara registrerade spelare:', e);
        }
    }

    function saveUser() {
        try {
            if (appState.currentUser) {
                localStorage.setItem(AUTH_KEY, JSON.stringify(appState.currentUser));
            } else {
                localStorage.removeItem(AUTH_KEY);
            }
        } catch (e) {
            console.error('Kunde inte spara användare:', e);
        }
    }

    function logoutUser() {
        appState.currentUser = null;
        saveUser();
        renderUserStatus();
        renderApp();
        playAudioTone(400, 0.15);
    }

    // BroadcastChannel för öppna flikar på samma enhet
    try {
        if ('BroadcastChannel' in window) {
            broadcastChannel = new BroadcastChannel('pinta_padel_sync_channel');
            broadcastChannel.onmessage = (event) => {
                if (event.data && event.data.type === 'STATE_UPDATED') {
                    loadState();
                    renderApp();
                }
            };
        }
    } catch (e) {
        console.warn('BroadcastChannel stöds ej:', e);
    }

    function broadcastLocalUpdate() {
        if (broadcastChannel) {
            broadcastChannel.postMessage({ type: 'STATE_UPDATED', timestamp: Date.now() });
        }
    }

    function checkUrlForSharedTournament() {
        const urlParams = new URLSearchParams(window.location.search);
        const tourneyId = urlParams.get('t');
        const adminKeyParam = urlParams.get('key') || urlParams.get('admin');
        const hash = window.location.hash;

        if (hash && (hash.startsWith('#invite=') || hash.startsWith('#data='))) {
            try {
                const encoded = hash.replace('#invite=', '').replace('#data=', '');
                const decompressed = decodeURIComponent(atob(encoded));
                const imported = JSON.parse(decompressed);
                if (imported && imported.id) {
                    const existingIndex = appState.tournaments.findIndex(t => t.id === imported.id);
                    if (existingIndex >= 0) {
                        // Behåll eventuell lokal adminKey om den saknades i den delade publika datan
                        if (!imported.adminKey && appState.tournaments[existingIndex].adminKey) {
                            imported.adminKey = appState.tournaments[existingIndex].adminKey;
                        }
                        appState.tournaments[existingIndex] = imported;
                    } else {
                        appState.tournaments.push(imported);
                    }
                    appState.activeTournamentId = imported.id;
                    saveState();
                }
            } catch (err) {
                console.warn('Kunde inte läsa turneringsdata från hash:', err);
            }
        } else if (tourneyId) {
            const found = appState.tournaments.find(t => t.id === tourneyId);
            if (found) {
                appState.activeTournamentId = tourneyId;
            }
        }

        // Om en arrangörsnyckel skickas i URL:en (?key=adm_xxx) -> Lås upp full arrangörsbehörighet!
        const active = getActiveTournament();
        if (active && adminKeyParam) {
            if (!active.adminKey || active.adminKey === adminKeyParam) {
                active.adminKey = adminKeyParam;
                saveAdminKeyForTourney(active.id, adminKeyParam);
                appState.currentUser = {
                    id: (active.organizer && active.organizer.id) ? active.organizer.id : ('admin_' + active.id),
                    name: (active.organizer && active.organizer.name) ? active.organizer.name : 'Arrangör',
                    role: 'admin',
                    tourneyKey: adminKeyParam
                };
                saveUser();
                saveState();
            }
        }
    }

    // =========================================================================
    // 5. REALTIDSSYNK VIA PAHO MQTT
    // =========================================================================

    function initCloudSync() {
        const active = getActiveTournament();
        if (!active) return;

        if (typeof Paho === 'undefined' || !Paho.MQTT) {
            updateCloudStatus(true, 'Lokal synk (Aktiv)');
            return;
        }

        try {
            if (mqttClient && mqttClient.isConnected()) {
                return;
            }

            const clientId = 'pinta_' + Math.random().toString(16).substr(2, 8);
            mqttClient = new Paho.MQTT.Client('broker.hivemq.com', 8884, '/mqtt', clientId);

            mqttClient.onConnectionLost = (responseObject) => {
                appState.cloudConnected = false;
                updateCloudStatus(false, 'Återansluter...');
                setTimeout(initCloudSync, 4000);
            };

            mqttClient.onMessageArrived = (message) => {
                try {
                    const payload = JSON.parse(message.payloadString);
                    if (payload && payload.tourney && payload.tourney.id === appState.activeTournamentId) {
                        const localTourney = getActiveTournament();
                        if (payload.tourney.players.length !== (localTourney ? localTourney.players.length : 0) ||
                            payload.tourney.status !== (localTourney ? localTourney.status : '') ||
                            (payload.tourney.rounds && payload.tourney.rounds.length > 0 && (!localTourney.rounds || localTourney.rounds.length === 0))) {
                            
                            const idx = appState.tournaments.findIndex(t => t.id === payload.tourney.id);
                            if (idx >= 0) {
                                appState.tournaments[idx] = payload.tourney;
                            } else {
                                appState.tournaments.push(payload.tourney);
                            }
                            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                                tournaments: appState.tournaments,
                                deletedTournaments: appState.deletedTournaments,
                                activeTournamentId: appState.activeTournamentId
                            }));
                            renderApp();
                            playAudioTone(700, 0.1);
                        }
                    }
                } catch (e) {
                    console.warn('MQTT felaktigt meddelande:', e);
                }
            };

            mqttClient.connect({
                useSSL: true,
                timeout: 5,
                keepAliveInterval: 30,
                onSuccess: () => {
                    appState.cloudConnected = true;
                    updateCloudStatus(true, 'Live Synkad (Internet)');
                    const topic = `pinta_padel_tour/tourney/${active.id}`;
                    mqttClient.subscribe(topic);
                },
                onFailure: (err) => {
                    appState.cloudConnected = false;
                    updateCloudStatus(true, 'Synkad (Lokal)');
                }
            });
        } catch (e) {
            updateCloudStatus(true, 'Lokal synk');
        }
    }

    function syncToCloud() {
        const active = getActiveTournament();
        if (!active) return;

        if (mqttClient && mqttClient.isConnected()) {
            try {
                const topic = `pinta_padel_tour/tourney/${active.id}`;
                const payload = JSON.stringify({
                    type: 'SYNC',
                    tourney: active,
                    sender: appState.currentUser ? appState.currentUser.id : 'unknown',
                    timestamp: Date.now()
                });
                const message = new Paho.MQTT.Message(payload);
                message.destinationName = topic;
                message.retained = true;
                mqttClient.send(message);
            } catch (e) {
                console.warn('Kunde inte publicera MQTT:', e);
            }
        }
    }

    function updateCloudStatus(isOnline, customText) {
        const dot = document.querySelector('.cloud-dot');
        const text = document.getElementById('cloudStatusText');
        if (dot && text) {
            if (isOnline) {
                dot.style.background = '#00e676';
                dot.style.boxShadow = '0 0 8px #00e676';
                text.textContent = customText || 'Live Synkad';
            } else {
                dot.style.background = '#ffb703';
                dot.style.boxShadow = 'none';
                text.textContent = customText || 'Offline';
            }
        }
    }

    // =========================================================================
    // 6. RADERING & ÅTERSTÄLLNING AV TURNERINGAR (PAPPERSKORG & ÅNGRA)
    // =========================================================================

    /**
     * Radera turnering – Flyttas till papperskorgen med möjlighet att tas tillbaka!
     */
    function deleteTournament(tourneyId, isPermanent = false) {
        const tourney = appState.tournaments.find(t => t.id === tourneyId) || appState.deletedTournaments.find(t => t.id === tourneyId);
        if (tourney && !isUserOrganizerOf(tourney) && (!appState.currentUser || appState.currentUser.role !== 'admin')) {
            alert(`Endast turneringens arrangör (${tourney.organizer ? tourney.organizer.name : 'Admin'}) har behörighet att radera turneringen. Logga in med arrangörskoden om du styr från en ny enhet.`);
            openModal('modalAuth');
            return;
        }

        if (isPermanent) {
            const idx = appState.deletedTournaments.findIndex(t => t.id === tourneyId);
            if (idx >= 0) {
                const tourney = appState.deletedTournaments[idx];
                if (confirm(`Vill du radera "${tourney.name}" permanent ur papperskorgen? Detta kan inte ångras.`)) {
                    appState.deletedTournaments.splice(idx, 1);
                    saveState();
                    renderHistory();
                    playAudioTone(300, 0.1);
                }
            }
            return;
        }

        // Flytta till papperskorgen (Soft delete)
        const idx = appState.tournaments.findIndex(t => t.id === tourneyId);
        if (idx >= 0) {
            const tourney = appState.tournaments.splice(idx, 1)[0];
            tourney.deletedAt = new Date().toISOString();
            appState.deletedTournaments.unshift(tourney);

            // Om vi raderade den aktiva turneringen, byt till nästa tillgängliga
            if (appState.activeTournamentId === tourneyId) {
                appState.activeTournamentId = appState.tournaments.length > 0 ? appState.tournaments[0].id : null;
            }

            saveState();
            renderApp();
            showUndoToast(tourney);
            playAudioTone(400, 0.15);
        }
    }

    /**
     * Ta tillbaka / Återställ turnering från papperskorgen
     */
    function restoreTournament(tourneyId) {
        const idx = appState.deletedTournaments.findIndex(t => t.id === tourneyId);
        if (idx >= 0) {
            const tourney = appState.deletedTournaments.splice(idx, 1)[0];
            delete tourney.deletedAt;
            appState.tournaments.unshift(tourney);
            appState.activeTournamentId = tourney.id;

            hideUndoToast();
            saveState();
            renderApp();
            playAudioTone(659.25, 0.2); // E5
        }
    }

    /**
     * Töm papperskorgen helt
     */
    function emptyTrash() {
        if (!appState.deletedTournaments || appState.deletedTournaments.length === 0) {
            alert('Papperskorgen är redan tom.');
            return;
        }

        if (confirm(`Vill du tömma papperskorgen permanent? Alla ${appState.deletedTournaments.length} raderade turneringar tas bort helt.`)) {
            appState.deletedTournaments = [];
            saveState();
            renderHistory();
            playAudioTone(250, 0.15);
        }
    }

    /**
     * Ångra-toast vid radering
     */
    function showUndoToast(tourney) {
        const container = document.getElementById('toastContainer');
        if (!container) return;
        hideUndoToast();

        const toast = document.createElement('div');
        toast.className = 'toast-undo';
        toast.id = 'activeUndoToast';
        toast.innerHTML = `
            <span>🗑️ Turneringen "<b>${escapeHtml(tourney.name)}</b>" flyttades till papperskorgen.</span>
            <button type="button" class="toast-undo-btn">Ångra ↺</button>
        `;

        toast.querySelector('.toast-undo-btn').addEventListener('click', () => {
            restoreTournament(tourney.id);
        });

        container.appendChild(toast);

        undoToastTimer = setTimeout(() => {
            hideUndoToast();
        }, 8000);
    }

    function hideUndoToast() {
        if (undoToastTimer) clearTimeout(undoToastTimer);
        const el = document.getElementById('activeUndoToast');
        if (el) el.remove();
    }

    // =========================================================================
    // 7. TURNERINGSAKTIVITETER & SPELARREGISTRERING
    // =========================================================================

    function getActiveTournament() {
        return appState.tournaments.find(t => t.id === appState.activeTournamentId) || null;
    }

    /**
     * Skapa ny turnering i Pinta Padel Tour (Helt utan mail)
     * - Genererar unik adminKey och arrangörskod (PT-xx)
     * - Sparar adminKey i localStorage på denna enhet -> Automatisk arrangörsbehörighet!
     * - Om organizerPlays är sant: lägger automatiskt in arrangören på Plats 1 direkt med personlig PIN-kod.
     */
    function createNewTournament(name, format, pointSystem, organizerData, organizerPlays = true) {
        const id = 'pinta_' + Date.now();
        const adminKey = 'adm_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
        const adminCode = 'PT-' + Math.floor(10 + Math.random() * 90);

        const orgName = (organizerData && organizerData.name) ? organizerData.name.trim() : 'Ulrik';

        // Spara senaste arrangörsuppgifter i localStorage för bekvämlighet
        try {
            localStorage.setItem('pinta_padel_last_organizer', JSON.stringify({ name: orgName }));
        } catch (e) {}

        const newTourney = {
            id: id,
            name: name || `Pinta Padel Tour – ${new Date().toLocaleDateString('sv-SE')}`,
            format: format || 'option1',
            pointSystem: pointSystem || 'games', // Standard: Game-räkning
            createdAt: new Date().toISOString(),
            status: 'lobby',
            players: [],
            rounds: [],
            currentRoundIndex: 0,
            adminKey: adminKey,
            adminCode: adminCode,
            organizer: {
                id: 'org_' + Date.now(),
                name: orgName
            }
        };

        // Spara adminnyckel lokalt på denna enhet -> Automatisk arrangörsbehörighet utan lösenord!
        saveAdminKeyForTourney(id, adminKey);

        // Gör skaparen inloggad som arrangör direkt
        appState.currentUser = {
            id: newTourney.organizer.id,
            name: orgName,
            role: 'admin',
            tourneyKey: adminKey
        };

        // Om arrangören också ska spela: lägg till på Plats 1 direkt med en egen 4-siffrig PIN!
        if (organizerPlays) {
            const orgPin = Math.floor(1000 + Math.random() * 9000).toString();
            const orgPlayer = {
                id: newTourney.organizer.id,
                name: orgName,
                pin: orgPin,
                registeredAt: new Date().toISOString(),
                avatar: orgName.charAt(0).toUpperCase()
            };
            newTourney.players.push(orgPlayer);

            // Spara i centrala spelarregistret
            if (!appState.registeredPlayers) appState.registeredPlayers = [];
            const exists = appState.registeredPlayers.some(rp => rp.name.toLowerCase() === orgName.toLowerCase());
            if (!exists) {
                appState.registeredPlayers.push({
                    id: orgPlayer.id,
                    name: orgName,
                    pin: orgPin,
                    registeredAt: new Date().toISOString()
                });
                saveRegisteredPlayers();
            }
            appState.currentUser.pin = orgPin;
        }

        saveUser();
        appState.tournaments.unshift(newTourney);
        appState.activeTournamentId = id;
        saveState();
        playAudioTone(523.25, 0.15); // C5

        initCloudSync();
        return newTourney;
    }

    /**
     * Registrera en spelare i Pinta Padel Tour (100% utan mail: bara namn + 4-siffrig kod)
     * - Slumpar en 4-siffrig PIN-kod
     * - Sparar automatiskt i telefonen (localStorage) så att spelaren är inloggad direkt
     * - Visar bekräftelsemodal med koden direkt på skärmen
     */
    function registerPlayer(tourney, playerData, showConfirmationModal = true) {
        if (!tourney) return false;

        if (tourney.players.length >= 8) {
            alert('Turneringen har redan nått maxantalet 8 spelare! Lottning kan nu genomföras.');
            return false;
        }

        const name = (typeof playerData === 'string' ? playerData : (playerData && playerData.name ? playerData.name : '')).trim();

        if (!name) {
            alert('Vänligen ange ett namn för att ta en plats.');
            return false;
        }

        const alreadyExists = tourney.players.some(p => {
            const pName = typeof p === 'string' ? p : p.name;
            return pName.toLowerCase() === name.toLowerCase();
        });

        if (alreadyExists) {
            alert(`Spelaren "${name}" är redan anmäld till denna turnering.`);
            return false;
        }

        // Hämta eller skapa i centrala spelarregistret
        if (!appState.registeredPlayers) appState.registeredPlayers = [];
        let regPlayer = appState.registeredPlayers.find(rp => rp.name.toLowerCase() === name.toLowerCase());

        const generatedPin = Math.floor(1000 + Math.random() * 9000).toString();

        if (!regPlayer) {
            regPlayer = {
                id: 'player_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                name: name,
                pin: generatedPin,
                registeredAt: new Date().toISOString()
            };
            appState.registeredPlayers.push(regPlayer);
            saveRegisteredPlayers();
        } else if (!regPlayer.pin) {
            regPlayer.pin = generatedPin;
            saveRegisteredPlayers();
        }

        const newPlayer = {
            id: regPlayer.id,
            name: regPlayer.name,
            pin: regPlayer.pin,
            registeredAt: new Date().toISOString(),
            avatar: regPlayer.name.charAt(0).toUpperCase()
        };

        tourney.players.push(newPlayer);

        // Spara automatiskt i spelarens telefon och logga in direkt!
        appState.currentUser = {
            id: newPlayer.id,
            name: newPlayer.name,
            pin: newPlayer.pin,
            role: 'player'
        };
        saveUser();
        renderUserStatus();

        // Visa koden direkt på skärmen i bekräftelsemodalen
        if (showConfirmationModal) {
            const nameEl = document.getElementById('pinConfirmPlayerName');
            const badgeEl = document.getElementById('pinConfirmSlotBadge');
            const codeEl = document.getElementById('pinConfirmCodeDisplay');

            if (nameEl) nameEl.textContent = newPlayer.name;
            if (badgeEl) badgeEl.textContent = `Plats ${tourney.players.length} av 8`;
            if (codeEl) codeEl.textContent = newPlayer.pin;

            openModal('modalPinConfirmation');
        }

        if (tourney.players.length === 8) {
            playAudioTone(783.99, 0.3); // G5 notis att alla 8 är anmälda
        } else {
            playAudioTone(600, 0.15);
        }

        saveState();
        renderApp();
        return true;
    }

    function removePlayer(tourney, playerIndex) {
        if (!tourney || playerIndex < 0 || playerIndex >= tourney.players.length) return;

        const targetPlayer = tourney.players[playerIndex];
        const pName = typeof targetPlayer === 'string' ? targetPlayer : targetPlayer.name;

        const isSelf = appState.currentUser && appState.currentUser.name && pName && 
            (appState.currentUser.name.toLowerCase() === pName.toLowerCase());

        if (!isUserOrganizerOf(tourney) && !isSelf) {
            alert('Endast turneringens arrangör kan ta bort anmälda spelare. Om du är arrangör och styr från en annan enhet, ange din arrangörskod.');
            openModal('modalAuth');
            return;
        }

        tourney.players.splice(playerIndex, 1);

        if (tourney.status === 'active' && tourney.players.length < 8) {
            tourney.status = 'lobby';
            tourney.rounds = [];
        }

        saveState();
        renderApp();
    }

    function saveMatchScore(matchId, score1, score2) {
        const tourney = getActiveTournament();
        if (!tourney || !tourney.rounds) return;

        // Kräver inloggning för att kunna spara/ändra resultat
        if (!appState.currentUser) {
            alert('Du måste vara inloggad för att kunna rapportera eller ändra resultat.');
            const guestPrompt = document.getElementById('authNoticeGuestPrompt');
            if (guestPrompt) guestPrompt.style.display = 'block';
            openModal('modalAuth');
            return;
        }

        let matchFound = null;
        for (const round of tourney.rounds) {
            const m = round.matches.find(item => item.id === matchId);
            if (m) {
                m.score1 = score1;
                m.score2 = score2;
                m.completed = (score1 !== null && score2 !== null && score1 !== '' && score2 !== '');
                m.updatedAt = new Date().toISOString();
                matchFound = m;
                break;
            }
        }

        if (matchFound) {
            const allMatches = tourney.rounds.flatMap(r => r.matches);
            const allCompleted = allMatches.every(m => m.completed);
            
            if (allCompleted && tourney.status !== 'completed') {
                tourney.status = 'completed';
                celebrateWinner();
            }

            saveState();
            renderApp();
            playAudioTone(659.25, 0.2); // E5
        }
    }

    // =========================================================================
    // 8. INBJUDNINGAR & DELNING (MESSENGER, WHATSAPP, LÄNK)
    // =========================================================================

    function getInviteUrl(tourney) {
        if (!tourney) return window.location.href;

        const payload = {
            id: tourney.id,
            name: tourney.name,
            format: tourney.format,
            pointSystem: tourney.pointSystem,
            status: tourney.status,
            players: tourney.players,
            createdAt: tourney.createdAt,
            organizer: tourney.organizer,
            adminCode: tourney.adminCode
            // adminKey utelämnas medvetet från publika länkar för säkerhet
        };
        const encoded = btoa(encodeURIComponent(JSON.stringify(payload)));
        
        const base = window.location.origin && !window.location.origin.startsWith('file')
            ? `${window.location.origin}${window.location.pathname}`
            : window.location.href.split('?')[0].split('#')[0];

        return `${base}?t=${tourney.id}#invite=${encoded}`;
    }

    /**
     * Personlig arrangörslänk: innehåller hemliga admin-nyckeln så arrangören kan styra från iPad/dator
     */
    function getOrganizerUrl(tourney) {
        if (!tourney) return window.location.href;
        const base = window.location.origin && !window.location.origin.startsWith('file')
            ? `${window.location.origin}${window.location.pathname}`
            : window.location.href.split('?')[0].split('#')[0];
        return `${base}?t=${tourney.id}&key=${tourney.adminKey || ''}`;
    }

    function getInviteMessageText(tourney) {
        const url = getInviteUrl(tourney);
        const freeSlots = Math.max(0, 8 - (tourney ? tourney.players.length : 0));
        const orgName = (tourney && tourney.organizer && tourney.organizer.name) ? tourney.organizer.name : 'Arrangören';
        return `🎾 Hej! ${orgName} bjuder in dig till Pinta Padel Tour: "${tourney ? tourney.name : 'Turnering'}"!\nDet finns 8 platser totalt (${freeSlots} st kvar). Lottning genomförs så fort alla 8 platser är tagna.\n\nKlicka på länken och fyll bara i ditt namn för att ta en plats:\n${url}`;
    }

    function shareViaMessenger(tourney) {
        const text = getInviteMessageText(tourney);
        const url = getInviteUrl(tourney);

        copyTextToClipboard(text);

        if (navigator.share && /mobile|android|iphone/i.test(navigator.userAgent)) {
            navigator.share({
                title: `Pinta Padel Tour: ${tourney.name}`,
                text: text,
                url: url
            }).catch(() => {});
        } else {
            window.open(`https://www.messenger.com/`, '_blank');
            alert('Inbjudningstexten och länken har kopierats till urklipp! Klistra bara in den i din Messenger-chatt eller grupp.');
        }
    }

    function shareViaWhatsApp(tourney) {
        const text = getInviteMessageText(tourney);
        const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
        window.open(waUrl, '_blank');
    }

    function copyTextToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            return Promise.resolve();
        }
    }

    // =========================================================================
    // 9. LJUD & FIRANDE (WEB AUDIO API & CONFETTI)
    // =========================================================================

    function playAudioTone(freq, duration) {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, ctx.currentTime);
            gain.gain.setValueAtTime(0.08, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + duration);
        } catch (e) {
            // Web Audio ej tillgängligt
        }
    }

    function playFanfare() {
        const notes = [523.25, 659.25, 783.99, 1046.50];
        notes.forEach((freq, idx) => {
            setTimeout(() => playAudioTone(freq, 0.25), idx * 160);
        });
    }

    function showDrawCelebrationBanner() {
        const banner = document.getElementById('drawCelebrationBanner');
        if (banner) {
            banner.style.display = 'flex';
            setTimeout(() => {
                banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
        }
    }

    function celebrateWinner() {
        const tourney = getActiveTournament();
        if (!tourney) return;
        const leaderboard = calculateLeaderboard(tourney);
        if (leaderboard.length === 0) return;

        const winner = leaderboard[0];

        document.getElementById('podiumWinnerName').textContent = winner.name;
        document.getElementById('podiumWinnerScore').textContent = 
            `${winner.totalPoints} poäng · ${winner.wins} vinster · Diff: ${winner.pointDiff > 0 ? '+' : ''}${winner.pointDiff}`;
        
        openModal('modalPodium');
        playFanfare();
        startConfetti();
    }

    function startConfetti() {
        const canvas = document.getElementById('confettiCanvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const particles = [];
        const colors = ['#00e676', '#00b4d8', '#ffd166', '#ff5252', '#ffffff'];

        for (let i = 0; i < 120; i++) {
            particles.push({
                x: Math.random() * canvas.width,
                y: Math.random() * -canvas.height,
                r: Math.random() * 6 + 3,
                d: Math.random() * 10 + 5,
                color: colors[Math.floor(Math.random() * colors.length)],
                tilt: Math.random() * 10 - 10,
                tiltAngleIncremental: Math.random() * 0.07 + 0.05,
                tiltAngle: 0
            });
        }

        let frames = 0;
        function draw() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            particles.forEach(p => {
                p.tiltAngle += p.tiltAngleIncremental;
                p.y += (Math.cos(p.d) + 3 + p.r / 2) / 1.5;
                p.x += Math.sin(p.d);
                p.tilt = Math.sin(p.tiltAngle - (frames / 3)) * 15;

                ctx.beginPath();
                ctx.lineWidth = p.r;
                ctx.strokeStyle = p.color;
                ctx.moveTo(p.x + p.tilt + p.r / 2, p.y);
                ctx.lineTo(p.x + p.tilt, p.y + p.tilt + p.r / 2);
                ctx.stroke();
            });

            frames++;
            if (frames < 240) {
                requestAnimationFrame(draw);
            } else {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
        }

        draw();
    }

    // =========================================================================
    // 10. RENDERING & UI-UPPDATERING
    // =========================================================================

    function renderApp() {
        const tourney = getActiveTournament();

        if (tourney) {
            document.getElementById('contentContainer').style.display = 'block';
            document.getElementById('emptyStateContainer').style.display = 'none';

            document.getElementById('activeTournamentTitle').textContent = tourney.name;
            const badge = document.getElementById('activeTournamentBadge');
            const btnBannerDraw = document.getElementById('btnBannerDraw');

            const playerCount = tourney.players ? tourney.players.length : 0;
            document.getElementById('tabLobbyPlayerCount').textContent = playerCount;

            const isOrg = isUserOrganizerOf(tourney);
            const orgName = (tourney.organizer && tourney.organizer.name) ? tourney.organizer.name : 'Ulrik';
            const orgPrefix = isOrg ? '👑 Du är arrangör' : `👑 Arrangör: ${orgName}`;

            if (tourney.status === 'lobby' || playerCount < 8) {
                btnBannerDraw.style.display = 'none';
                badge.textContent = `🟡 Väntrum (${playerCount}/8 spelare)`;
                badge.style.color = 'var(--warning)';
                badge.style.borderColor = 'rgba(255, 183, 3, 0.4)';
                badge.style.background = 'rgba(255, 183, 3, 0.12)';
                document.getElementById('activeTournamentMeta').textContent = 
                    `${orgPrefix} · ${8 - playerCount} platser kvar · Skicka inbjudningslänk via Messenger eller E-post`;
            } else if (playerCount === 8 && tourney.status !== 'active' && tourney.status !== 'completed') {
                btnBannerDraw.style.display = 'inline-flex';
                badge.textContent = `🟡 8/8 anmälda · Redo för lottning`;
                badge.style.color = 'var(--warning)';
                badge.style.borderColor = 'rgba(255, 183, 3, 0.4)';
                badge.style.background = 'rgba(255, 183, 3, 0.12)';
                document.getElementById('activeTournamentMeta').textContent = 
                    `${orgPrefix} · Alla 8 spelare är anmälda! ${isOrg ? 'Klicka på "Lotta spelordning" för att starta.' : 'Väntar på att arrangören ska lotta.'}`;
            } else {
                btnBannerDraw.style.display = 'none';
                badge.textContent = tourney.format === 'option1' 
                    ? 'Lag-serie (7 omgångar × 3 matcher)' 
                    : 'Bana-rotation (4 på samma bana)';
                badge.style.color = 'var(--accent-blue)';
                badge.style.borderColor = 'rgba(0, 180, 216, 0.3)';
                badge.style.background = 'rgba(0, 180, 216, 0.15)';

                const totalMatches = (tourney.rounds || []).flatMap(r => r.matches || []).length;
                const doneMatches = (tourney.rounds || []).flatMap(r => r.matches || []).filter(m => m.completed).length;
                document.getElementById('activeTournamentMeta').textContent = 
                    `${orgPrefix} · ${doneMatches} av ${totalMatches} matcher spelade · Status: ${tourney.status === 'completed' ? '🏆 Avslutad' : '🟢 Pågår'}`;
            }

            renderLobbyView(tourney);
            renderLeaderboard(tourney);
            renderMatches(tourney);

        } else {
            document.getElementById('activeTournamentTitle').textContent = 'Ingen aktiv turnering';
            document.getElementById('activeTournamentBadge').textContent = 'Skapa ny turnering';
            document.getElementById('activeTournamentMeta').textContent = 'Klicka nedan för att starta en turnering och bjuda in spelare';
            document.getElementById('contentContainer').style.display = 'none';
            document.getElementById('emptyStateContainer').style.display = 'block';
        }

        renderHistory();
        renderUserStatus();
    }

    /**
     * Rendera Väntrum & 8 Spelarplatser & Manuell Lottningsknapp
     */
    function renderLobbyView(tourney) {
        const playerCount = tourney.players ? tourney.players.length : 0;
        const percent = Math.min(100, Math.round((playerCount / 8) * 100));

        document.getElementById('lobbyProgressBar').style.width = `${percent}%`;
        document.getElementById('lobbyCountBadge').textContent = `${playerCount} av 8 platser fyllda (${percent}%)`;
        
        const statusText = document.getElementById('lobbyProgressStatusText');
        const drawBox = document.getElementById('drawActionBox');
        const btnDraw = document.getElementById('btnDrawSchedule');
        const drawIcon = document.getElementById('drawActionIcon');
        const drawTitle = document.getElementById('drawActionTitle');
        const drawDesc = document.getElementById('drawActionDesc');

        if (playerCount < 8) {
            statusText.textContent = `${8 - playerCount} lediga platser. Bjud in vänner via Messenger, WhatsApp eller direktlänk.`;
            drawBox.classList.add('disabled');
            drawIcon.textContent = '⏳';
            drawTitle.textContent = 'Lottning av Spelordning';
            drawDesc.textContent = `Kräver att alla 8 platser ska fyllas innan lottningsknappen aktiveras (just nu ${playerCount} av 8).`;
            btnDraw.disabled = true;
            btnDraw.style.opacity = '0.5';
            btnDraw.style.cursor = 'not-allowed';
            btnDraw.className = 'btn btn-secondary btn-lg';
            btnDraw.innerHTML = `<span>🎲</span> Lotta spelordning (${playerCount}/8)`;
        } else if (tourney.status !== 'active' && tourney.status !== 'completed') {
            statusText.textContent = `Alla 8 platser är fyllda! Klicka på lottningsknappen för att genomföra lottningen.`;
            drawBox.classList.remove('disabled');
            drawIcon.textContent = '🎲';
            drawTitle.textContent = 'Alla 8 spelare är anmälda! Redo för lottning';
            drawDesc.textContent = 'Klicka på knappen nedan för att slumpa spelordningen och starta spelschemat.';
            btnDraw.disabled = false;
            btnDraw.style.opacity = '1';
            btnDraw.style.cursor = 'pointer';
            btnDraw.className = 'btn btn-primary btn-lg';
            btnDraw.innerHTML = `<span>🎲</span> Lotta spelordning nu! 🎾`;
        } else {
            statusText.textContent = `Lottningen är genomförd och turneringen är aktiv!`;
            drawBox.classList.remove('disabled');
            drawIcon.textContent = '✅';
            drawTitle.textContent = 'Lottning genomförd';
            drawDesc.textContent = 'Spelschemat och tabellen är igång. Klicka för att se matcherna på Bana 1 & 2.';
            btnDraw.disabled = false;
            btnDraw.style.opacity = '1';
            btnDraw.style.cursor = 'pointer';
            btnDraw.className = 'btn btn-secondary btn-lg';
            btnDraw.innerHTML = `<span>🎾</span> Visa spelschema`;
        }

        const grid = document.getElementById('lobbySlotsGrid');
        grid.innerHTML = '';

        for (let i = 0; i < 8; i++) {
            const player = tourney.players && tourney.players[i] ? tourney.players[i] : null;
            const card = document.createElement('div');

            if (player) {
                const pName = typeof player === 'string' ? player : player.name;
                const pPin = typeof player === 'object' && player.pin ? player.pin : '';
                const avatarLetter = (pName || '?').charAt(0).toUpperCase();

                card.className = 'slot-card occupied';
                card.innerHTML = `
                    <div class="slot-left">
                        <div class="slot-avatar">${escapeHtml(avatarLetter)}</div>
                        <div class="slot-info">
                            <div class="slot-name">${escapeHtml(pName)}</div>
                            <div class="slot-meta">
                                <span>Plats ${i + 1}</span>
                                ${pPin ? `<span class="pin-badge" title="Personlig inloggningskod för ${escapeHtml(pName)}">🔑 Kod: ${escapeHtml(pPin)}</span>` : ''}
                            </div>
                        </div>
                    </div>
                    <button type="button" class="btn-remove-slot" title="Ta bort spelare" data-index="${i}">✕</button>
                `;

                card.querySelector('.btn-remove-slot').addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (confirm(`Vill du ta bort "${pName}" från turneringen?`)) {
                        removePlayer(tourney, i);
                    }
                });

            } else {
                card.className = 'slot-card vacant';
                card.innerHTML = `
                    <div class="slot-left">
                        <div class="slot-avatar vacant">${i + 1}</div>
                        <div class="slot-info">
                            <div class="slot-name" style="color: var(--text-muted);">Plats ${i + 1}: Ledig</div>
                            <div class="slot-meta">Väntar på anmälan...</div>
                        </div>
                    </div>
                    <button type="button" class="btn btn-secondary btn-sm btn-manual-add" data-index="${i}">
                        ➕ Lägg till
                    </button>
                `;

                card.querySelector('.btn-manual-add').addEventListener('click', (e) => {
                    e.stopPropagation();
                    document.getElementById('manualSlotIndex').value = i;
                    document.getElementById('manualPlayerName').value = '';

                    // Hämta registrerade spelare som INTE redan är med i denna turnering
                    const currentNames = (tourney.players || []).map(p => (typeof p === 'string' ? p : p.name).toLowerCase());
                    const availableReg = (appState.registeredPlayers || []).filter(rp => {
                        const rName = (rp.name || '').toLowerCase();
                        return !currentNames.includes(rName);
                    });

                    const boxExisting = document.getElementById('boxExistingRegisteredPlayers');
                    const selectExisting = document.getElementById('selectExistingPlayer');

                    if (boxExisting && selectExisting) {
                        if (availableReg.length > 0) {
                            boxExisting.style.display = 'block';
                            selectExisting.innerHTML = availableReg.map(p => 
                                `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (Kod: ${escapeHtml(p.pin || '----')})</option>`
                            ).join('');
                        } else {
                            boxExisting.style.display = 'none';
                        }
                    }

                    openModal('modalManualPlayer');
                });
            }

            grid.appendChild(card);
        }

        const isUserRegistered = appState.currentUser && tourney.players.some(p => {
            const pName = typeof p === 'string' ? p : p.name;
            return pName.toLowerCase() === appState.currentUser.name.toLowerCase();
        });

        const alreadyNotice = document.getElementById('alreadyRegisteredNotice');
        const formQuickReg = document.getElementById('formQuickRegisterName');

        if (isUserRegistered) {
            if (alreadyNotice) {
                alreadyNotice.style.display = 'block';
                const myPin = appState.currentUser.pin;
                document.getElementById('alreadyRegisteredDetails').innerHTML = 
                    `Du är anmäld som <strong>${escapeHtml(appState.currentUser.name)}</strong>${myPin ? ` (Din personliga kod är <span class="pin-badge">🔑 ${escapeHtml(myPin)}</span>)` : ''}. När alla 8 platser fyllts genomförs lottningen!`;
            }
            if (formQuickReg) formQuickReg.style.display = 'none';
        } else if (playerCount >= 8) {
            if (alreadyNotice) {
                alreadyNotice.style.display = 'block';
                document.getElementById('alreadyRegisteredDetails').textContent = 
                    `Turneringen är fulltecknad (8/8 spelare). Du kan följa tabellen och matcherna live!`;
            }
            if (formQuickReg) formQuickReg.style.display = 'none';
        } else {
            if (alreadyNotice) alreadyNotice.style.display = 'none';
            if (formQuickReg) formQuickReg.style.display = 'block';
        }
    }

    /**
     * Rendera Tabell & Liveresultat (Visas även för icke inloggade besökare)
     */
    function renderLeaderboard(tourney) {
        const lockedBanner = document.getElementById('leaderboardLockedBanner');
        const activeContent = document.getElementById('leaderboardActiveContent');
        const lockedCount = document.getElementById('lockedCountText');

        const playerCount = tourney.players ? tourney.players.length : 0;

        if (tourney.status === 'lobby' || playerCount < 8 || !tourney.rounds || tourney.rounds.length === 0) {
            lockedBanner.style.display = 'block';
            activeContent.style.display = 'none';
            lockedCount.textContent = `${playerCount} av 8`;
            return;
        }

        lockedBanner.style.display = 'none';
        activeContent.style.display = 'block';

        // Anpassa kolumnrubriker dynamiskt för Game-räkning vs 32p/24p
        const thScoreCol = document.getElementById('thScoreCol');
        const thDiffCol = document.getElementById('thDiffCol');
        const thPointsCol = document.getElementById('thPointsCol');

        const isGames = (tourney.pointSystem || 'games') === 'games';
        if (thScoreCol) thScoreCol.textContent = isGames ? 'Game (V - F)' : 'Bollar (G - I)';
        if (thDiffCol) thDiffCol.textContent = isGames ? 'Diff' : 'Diff';
        if (thPointsCol) thPointsCol.textContent = isGames ? 'Vunna Game' : (tourney.pointSystem === 'points24' ? 'Totalpoäng (24p)' : 'Totalpoäng (32p)');

        const tbody = document.getElementById('leaderboardBody');
        tbody.innerHTML = '';

        const leaderboard = calculateLeaderboard(tourney);

        leaderboard.forEach((player, index) => {
            const tr = document.createElement('tr');
            
            let rankDisplay = `${index + 1}`;
            if (index === 0) rankDisplay = `<span class="rank-badge rank-1">🥇</span>`;
            else if (index === 1) rankDisplay = `<span class="rank-badge rank-2">🥈</span>`;
            else if (index === 2) rankDisplay = `<span class="rank-badge rank-3">🥉</span>`;
            else rankDisplay = `<span style="display:inline-block;width:32px;text-align:center;font-weight:700;">${index + 1}</span>`;

            let diffClass = 'diff-zero';
            let diffPrefix = '';
            if (player.pointDiff > 0) {
                diffClass = 'diff-positive';
                diffPrefix = '+';
            } else if (player.pointDiff < 0) {
                diffClass = 'diff-negative';
            }

            tr.innerHTML = `
                <td class="rank-cell">${rankDisplay}</td>
                <td class="player-name-cell">${escapeHtml(player.name)}</td>
                <td style="text-align:center;">${player.matchesPlayed}</td>
                <td style="text-align:center;color:var(--primary);font-weight:700;">${player.wins}</td>
                <td style="text-align:center;color:var(--text-muted);">${player.losses}</td>
                <td style="text-align:center;">${player.pointsScored} - ${player.pointsConceded}</td>
                <td style="text-align:center;" class="${diffClass}">${diffPrefix}${player.pointDiff}</td>
                <td class="points-cell" style="text-align:right;">${player.totalPoints}</td>
            `;

            tbody.appendChild(tr);
        });
    }

    /**
     * Rendera Spelschema & Omgångar (Visas även för icke inloggade besökare)
     */
    function renderMatches(tourney) {
        const lockedBanner = document.getElementById('matchesLockedBanner');
        const activeContent = document.getElementById('matchesActiveContent');

        const playerCount = tourney.players ? tourney.players.length : 0;

        if (tourney.status === 'lobby' || playerCount < 8 || !tourney.rounds || tourney.rounds.length === 0) {
            lockedBanner.style.display = 'block';
            activeContent.style.display = 'none';
            return;
        }

        lockedBanner.style.display = 'none';
        activeContent.style.display = 'block';

        const btnReDraw = document.getElementById('btnReDrawSchedule');
        const hasScores = (tourney.rounds || []).flatMap(r => r.matches || []).some(m => m.completed);
        if (btnReDraw) {
            btnReDraw.style.display = hasScores ? 'none' : 'inline-flex';
        }

        const roundPillsContainer = document.getElementById('roundPillsContainer');
        roundPillsContainer.innerHTML = '';

        tourney.rounds.forEach((round, rIndex) => {
            const allDone = (round.matches || []).every(m => m.completed);
            const pill = document.createElement('button');
            pill.className = `round-pill ${rIndex === currentSelectedRound ? 'active' : ''} ${allDone ? 'completed' : ''}`;
            pill.textContent = `Omgång ${round.roundNumber}`;
            pill.addEventListener('click', () => {
                currentSelectedRound = rIndex;
                renderMatches(tourney);
            });
            roundPillsContainer.appendChild(pill);
        });

        const round = tourney.rounds[currentSelectedRound];
        if (!round) return;

        const court1Matches = (round.matches || []).filter(m => m.courtIndex === 1);
        const court2Matches = (round.matches || []).filter(m => m.courtIndex === 2);

        document.getElementById('court1Matches').innerHTML = court1Matches.map(m => createMatchHtml(m)).join('');
        document.getElementById('court2Matches').innerHTML = court2Matches.map(m => createMatchHtml(m)).join('');

        document.querySelectorAll('.match-item').forEach(el => {
            el.addEventListener('click', () => {
                const matchId = el.getAttribute('data-match-id');
                openScoreModal(matchId);
            });
        });
    }

    function createMatchHtml(match) {
        const team1Names = match.team1.players.map(p => escapeHtml(p)).join(' & ');
        const team2Names = match.team2.players.map(p => escapeHtml(p)).join(' & ');
        
        let scoreHtml = '';
        if (match.completed) {
            scoreHtml = `<div class="score-display">${match.score1} - ${match.score2}</div>`;
        } else {
            if (appState.currentUser) {
                scoreHtml = `<div class="score-pending">Mata in resultat →</div>`;
            } else {
                scoreHtml = `<div class="score-pending" style="color:var(--accent-blue);font-size:12px;">Ej spelad · Logga in 🔒</div>`;
            }
        }

        return `
            <div class="match-item ${match.completed ? 'done' : ''}" data-match-id="${match.id}">
                <div class="match-item-header">
                    <span>${match.slotLabel || 'Match'}</span>
                    <span class="match-status-badge ${match.completed ? 'status-done' : 'status-pending'}">
                        ${match.completed ? 'Klar' : 'Ej spelad'}
                    </span>
                </div>
                <div class="match-teams-grid">
                    <div class="team-box">
                        <div class="team-players">${team1Names}</div>
                    </div>
                    <div style="text-align:center;">
                        ${scoreHtml}
                    </div>
                    <div class="team-box" style="text-align:right;">
                        <div class="team-players">${team2Names}</div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Rendera Turneringsarkiv & Papperskorg
     */
    function renderHistory() {
        const historyContainer = document.getElementById('historyListContainer');
        const trashContainer = document.getElementById('trashListContainer');
        const activeCountEl = document.getElementById('archiveActiveCount');
        const trashCountEl = document.getElementById('archiveTrashCount');
        const tabCountEl = document.getElementById('tabHistoryCount');

        const activeCount = appState.tournaments.length;
        const trashCount = appState.deletedTournaments ? appState.deletedTournaments.length : 0;

        if (activeCountEl) activeCountEl.textContent = activeCount;
        if (trashCountEl) trashCountEl.textContent = trashCount;
        if (tabCountEl) tabCountEl.textContent = activeCount;

        // 1. Rendera aktiva turneringar
        historyContainer.innerHTML = '';
        if (activeCount === 0) {
            historyContainer.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:24px;">Inga sparade aktiva turneringar ännu.</p>';
        } else {
            appState.tournaments.forEach(tourney => {
                const leaderboard = calculateLeaderboard(tourney);
                const winner = leaderboard.length > 0 && tourney.status === 'completed' ? leaderboard[0] : null;
                const pCount = tourney.players ? tourney.players.length : 0;

                const card = document.createElement('div');
                card.className = 'history-card';
                card.innerHTML = `
                    <div>
                        <div class="history-name">${escapeHtml(tourney.name)}</div>
                        <div class="history-meta">
                            <span>📅 ${new Date(tourney.createdAt).toLocaleDateString('sv-SE')}</span>
                            <span>🎾 ${tourney.format === 'option1' ? 'Lag-serie' : 'Bana-rotation'}</span>
                            <span>👥 ${pCount}/8 spelare</span>
                            <span>${tourney.status === 'completed' ? '🏆 Avslutad' : tourney.status === 'active' ? '🟢 Pågår' : '🟡 Väntrum'}</span>
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:10px;">
                        ${winner ? `<div class="history-winner">🏆 <span>${escapeHtml(winner.name)}</span></div>` : ''}
                        <button type="button" class="btn btn-secondary btn-sm select-tourney-btn" data-id="${tourney.id}">
                            ${tourney.id === appState.activeTournamentId ? 'Aktiv' : 'Öppna'}
                        </button>
                        <button type="button" class="btn btn-danger-outline btn-sm delete-tourney-btn" data-id="${tourney.id}" title="Flytta till papperskorgen">
                            🗑️
                        </button>
                    </div>
                `;

                card.querySelector('.select-tourney-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    appState.activeTournamentId = tourney.id;
                    saveState();
                    initCloudSync();
                    renderApp();
                    switchTab('tabLobby');
                });

                card.querySelector('.delete-tourney-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (confirm(`Vill du flytta turneringen "${tourney.name}" till papperskorgen? Den kan tas tillbaka när som helst.`)) {
                        deleteTournament(tourney.id, false);
                    }
                });

                card.addEventListener('click', () => {
                    appState.activeTournamentId = tourney.id;
                    saveState();
                    initCloudSync();
                    renderApp();
                    switchTab('tabLobby');
                });

                historyContainer.appendChild(card);
            });
        }

        // 2. Rendera raderade turneringar (Papperskorg)
        trashContainer.innerHTML = '';
        if (trashCount === 0) {
            trashContainer.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:24px;">Papperskorgen är tom.</p>';
        } else {
            appState.deletedTournaments.forEach(tourney => {
                const card = document.createElement('div');
                card.className = 'trash-card';
                card.innerHTML = `
                    <div>
                        <div style="font-size:16px;font-weight:800;color:var(--text-primary);">${escapeHtml(tourney.name)}</div>
                        <div style="font-size:12.5px;color:var(--text-muted);margin-top:4px;display:flex;gap:10px;">
                            <span>Raderad: ${new Date(tourney.deletedAt || tourney.createdAt).toLocaleDateString('sv-SE')}</span>
                            <span>🎾 ${tourney.format === 'option1' ? 'Lag-serie' : 'Bana-rotation'}</span>
                            <span>👥 ${tourney.players ? tourney.players.length : 0}/8 spelare</span>
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <button type="button" class="btn btn-restore btn-sm restore-tourney-btn" data-id="${tourney.id}" title="Ta tillbaka turneringen">
                            ↺ Återställ turnering
                        </button>
                        <button type="button" class="btn btn-danger-outline btn-sm perm-delete-btn" data-id="${tourney.id}" title="Radera permanent">
                            🗑️ Ta bort permanent
                        </button>
                    </div>
                `;

                card.querySelector('.restore-tourney-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    restoreTournament(tourney.id);
                });

                card.querySelector('.perm-delete-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteTournament(tourney.id, true);
                });

                trashContainer.appendChild(card);
            });
        }
    }

    /**
     * Rendera Användarstatus i Header
     */
    function renderUserStatus() {
        const btnAuth = document.getElementById('btnUserAuth');
        const avatar = document.getElementById('headerUserAvatar');
        const nameEl = document.getElementById('headerUserName');
        const guestBanner = document.getElementById('guestModeBanner');
        const activeTourney = getActiveTournament();
        const isOrg = activeTourney && isUserOrganizerOf(activeTourney);

        if (appState.currentUser) {
            const role = isOrg ? 'admin' : (appState.currentUser.role || 'player');
            if (avatar) avatar.textContent = role === 'admin' ? '👑' : '🎾';
            if (nameEl) {
                if (role === 'admin') {
                    nameEl.textContent = `Arrangör (${appState.currentUser.name || 'Admin'})`;
                } else {
                    nameEl.textContent = `Spelare: ${appState.currentUser.name || 'Deltagare'}`;
                }
            }
            if (btnAuth) btnAuth.classList.remove('not-logged-in');
            if (guestBanner) guestBanner.style.display = 'none';
        } else if (isOrg) {
            if (avatar) avatar.textContent = '👑';
            if (nameEl) nameEl.textContent = `Arrangör (${activeTourney.organizer ? activeTourney.organizer.name : 'Du'})`;
            if (btnAuth) btnAuth.classList.remove('not-logged-in');
            if (guestBanner) guestBanner.style.display = 'none';
        } else {
            // Inte inloggad -> Gästläge (Visningsläge)
            if (avatar) avatar.textContent = '👤';
            if (nameEl) nameEl.textContent = 'Logga in';
            if (btnAuth) btnAuth.classList.add('not-logged-in');
            if (guestBanner) guestBanner.style.display = 'flex';
        }

        // Uppdatera även inloggningsmodalens status-box
        const loggedInBox = document.getElementById('authCurrentUserInfo');
        const loggedInText = document.getElementById('authLoggedInStatusText');
        const loggedInSub = document.getElementById('authLoggedInSubText');

        if (loggedInBox) {
            if (appState.currentUser) {
                loggedInBox.style.display = 'block';
                const roleLabel = (isOrg || appState.currentUser.role === 'admin') ? '👑 Arrangör (Admin)' : '🎾 Spelare';
                if (loggedInText) loggedInText.textContent = `Inloggad som: ${appState.currentUser.name}`;
                if (loggedInSub) loggedInSub.textContent = `Roll: ${roleLabel}${appState.currentUser.pin ? ' · Personlig kod: ' + appState.currentUser.pin : ''}`;
            } else {
                loggedInBox.style.display = 'none';
            }
        }
    }

    // =========================================================================
    // 11. MODALER & INMATNING
    // =========================================================================

    function openScoreModal(matchId) {
        const tourney = getActiveTournament();
        if (!tourney || !tourney.rounds) return;

        // Kräver inloggning för att kunna ändra matchresultat!
        if (!appState.currentUser) {
            const guestPrompt = document.getElementById('authNoticeGuestPrompt');
            if (guestPrompt) guestPrompt.style.display = 'block';
            openModal('modalAuth');
            return;
        }

        let match = null;
        for (const round of tourney.rounds) {
            match = (round.matches || []).find(m => m.id === matchId);
            if (match) break;
        }

        if (!match) return;
        currentEditingMatch = match;

        document.getElementById('modalMatchTitle').textContent = 
            `Omgång ${match.roundIndex + 1} · Bana ${match.courtIndex}`;
        
        document.getElementById('modalTeam1Name').textContent = match.team1.players.join(' & ');
        document.getElementById('modalTeam2Name').textContent = match.team2.players.join(' & ');

        const pointSys = tourney.pointSystem || 'games';
        const defaultScore1 = pointSys === 'games' ? 6 : (pointSys === 'points32' ? 16 : 12);
        const defaultScore2 = pointSys === 'games' ? 0 : (pointSys === 'points32' ? 16 : 12);

        const score1Input = document.getElementById('inputScore1');
        const score2Input = document.getElementById('inputScore2');

        score1Input.value = match.score1 !== null ? match.score1 : defaultScore1;
        score2Input.value = match.score2 !== null ? match.score2 : defaultScore2;

        renderQuickScores(pointSys);

        openModal('modalScore');
    }

    function renderQuickScores(pointSys) {
        const titleEl = document.getElementById('modalQuickScoresTitle');
        const container = document.getElementById('modalQuickScoresContainer');
        if (!container) return;

        container.innerHTML = '';

        let buttons = [];
        if (pointSys === 'games') {
            if (titleEl) titleEl.textContent = 'Snabbval (Game-räkning)';
            buttons = [
                { s1: 6, s2: 0, label: '6 - 0' },
                { s1: 6, s2: 1, label: '6 - 1' },
                { s1: 6, s2: 2, label: '6 - 2' },
                { s1: 6, s2: 3, label: '6 - 3' },
                { s1: 6, s2: 4, label: '6 - 4' },
                { s1: 7, s2: 5, label: '7 - 5' },
                { s1: 7, s2: 6, label: '7 - 6' },
                { s1: 4, s2: 4, label: '4 - 4' }
            ];
        } else if (pointSys === 'points32') {
            if (titleEl) titleEl.textContent = 'Snabbval (32 poäng)';
            buttons = [
                { s1: 16, s2: 16, label: '16 - 16' },
                { s1: 18, s2: 14, label: '18 - 14' },
                { s1: 20, s2: 12, label: '20 - 12' },
                { s1: 22, s2: 10, label: '22 - 10' },
                { s1: 24, s2: 8, label: '24 - 8' },
                { s1: 28, s2: 4, label: '28 - 4' }
            ];
        } else {
            if (titleEl) titleEl.textContent = 'Snabbval (24 poäng)';
            buttons = [
                { s1: 12, s2: 12, label: '12 - 12' },
                { s1: 14, s2: 10, label: '14 - 10' },
                { s1: 16, s2: 8, label: '16 - 8' },
                { s1: 18, s2: 6, label: '18 - 6' },
                { s1: 20, s2: 4, label: '20 - 4' }
            ];
        }

        buttons.forEach(b => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-quick-score';
            btn.textContent = b.label;
            btn.setAttribute('data-s1', b.s1);
            btn.setAttribute('data-s2', b.s2);
            btn.addEventListener('click', () => {
                document.getElementById('inputScore1').value = b.s1;
                document.getElementById('inputScore2').value = b.s2;
            });
            container.appendChild(btn);
        });
    }

    function openModal(modalId) {
        const el = document.getElementById(modalId);
        if (el) el.classList.add('open');
    }

    function closeModal(modalId) {
        const el = document.getElementById(modalId);
        if (el) el.classList.remove('open');
    }

    function switchTab(tabId) {
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));

        const targetBtn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
        const targetSec = document.getElementById(tabId);

        if (targetBtn) targetBtn.classList.add('active');
        if (targetSec) targetSec.classList.add('active');
    }

    function escapeHtml(string) {
        const entityMap = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        };
        return String(string || '').replace(/[&<>"']/g, s => entityMap[s]);
    }

    // =========================================================================
    // 12. EVENT LISTENERS
    // =========================================================================

    function setupEventListeners() {
        // Tab-navigering
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetTab = btn.getAttribute('data-tab');
                switchTab(targetTab);
            });
        });

        // Sub-tabs i Turneringsarkiv (Aktiva vs Papperskorg)
        const btnShowActive = document.getElementById('btnShowActiveTournaments');
        const btnShowTrash = document.getElementById('btnShowTrashTournaments');
        const secActive = document.getElementById('sectionActiveTournaments');
        const secTrash = document.getElementById('sectionTrashTournaments');

        if (btnShowActive && btnShowTrash && secActive && secTrash) {
            btnShowActive.addEventListener('click', () => {
                btnShowActive.classList.add('active');
                btnShowTrash.classList.remove('active');
                secActive.style.display = 'block';
                secTrash.style.display = 'none';
            });

            btnShowTrash.addEventListener('click', () => {
                btnShowTrash.classList.add('active');
                btnShowActive.classList.remove('active');
                secActive.style.display = 'none';
                secTrash.style.display = 'block';
            });
        }

        // Töm papperskorgen
        const btnEmptyTrash = document.getElementById('btnEmptyTrash');
        if (btnEmptyTrash) {
            btnEmptyTrash.addEventListener('click', emptyTrash);
        }

        // Radera aktiv turnering från bannern
        document.getElementById('btnDeleteCurrentTourney').addEventListener('click', () => {
            const tourney = getActiveTournament();
            if (!tourney) return;
            if (!isUserOrganizerOf(tourney)) {
                alert(`Endast turneringens arrangör (${tourney.organizer ? tourney.organizer.name : 'Admin'}) kan radera denna turnering.`);
                openAuthModalWithRegisteredList();
                return;
            }
            if (confirm(`Vill du flytta turneringen "${tourney.name}" till papperskorgen? Den kan tas tillbaka när som helst under fliken Turneringsarkiv.`)) {
                deleteTournament(tourney.id, false);
            }
        });

        // Öppna Skapa Ny Turnering – Fyller automatiskt i tidigare arrangörsuppgifter
        function openNewTournamentModal() {
            let lastOrg = null;
            try {
                const lastOrgRaw = localStorage.getItem('pinta_padel_last_organizer');
                if (lastOrgRaw) lastOrg = JSON.parse(lastOrgRaw);
            } catch (e) {}

            const defaultName = (lastOrg && lastOrg.name) || (appState.currentUser && appState.currentUser.name) || '';
            const inputName = document.getElementById('inputOrganizerName');
            const checkPlays = document.getElementById('checkOrganizerPlays');

            if (inputName && defaultName) inputName.value = defaultName;
            if (checkPlays) checkPlays.checked = true;

            document.getElementById('inputTourneyName').value = `Pinta Padel Tour – ${new Date().toLocaleDateString('sv-SE')}`;
            openModal('modalNewTournament');
        }

        document.getElementById('btnNewTournament').addEventListener('click', openNewTournamentModal);
        document.getElementById('btnEmptyCreate').addEventListener('click', openNewTournamentModal);

        document.getElementById('btnGoToMatchesFromBanner').addEventListener('click', () => {
            document.getElementById('drawCelebrationBanner').style.display = 'none';
            switchTab('tabMatches');
        });

        document.getElementById('btnGoToLobbyFromTable').addEventListener('click', () => switchTab('tabLobby'));
        document.getElementById('btnGoToLobbyFromMatches').addEventListener('click', () => switchTab('tabLobby'));

        // LOTTNINGSKNAPP (I VÄNTRUMMET)
        document.getElementById('btnDrawSchedule').addEventListener('click', () => {
            const tourney = getActiveTournament();
            if (!tourney) return;
            if (tourney.status === 'active' || tourney.status === 'completed') {
                switchTab('tabMatches');
            } else {
                if (!isUserOrganizerOf(tourney)) {
                    alert(`Lottningen måste startas av turneringens arrangör (${tourney.organizer ? tourney.organizer.name : 'Admin'}). Om du är arrangör och styr från en annan enhet, ange din arrangörskod.`);
                    const guestPrompt = document.getElementById('authNoticeGuestPrompt');
                    if (guestPrompt) guestPrompt.style.display = 'block';
                    openAuthModalWithRegisteredList();
                    return;
                }
                executeDraw(tourney);
            }
        });

        // LOTTNINGSKNAPP (I BANNERN)
        document.getElementById('btnBannerDraw').addEventListener('click', () => {
            const tourney = getActiveTournament();
            if (!tourney) return;
            if (!isUserOrganizerOf(tourney)) {
                alert(`Lottningen måste startas av turneringens arrangör (${tourney.organizer ? tourney.organizer.name : 'Admin'}). Om du är arrangör och styr från en annan enhet, ange din arrangörskod.`);
                openAuthModalWithRegisteredList();
                return;
            }
            executeDraw(tourney);
        });

        // KNAPP: GÖR NY LOTTNING
        document.getElementById('btnReDrawSchedule').addEventListener('click', () => {
            const tourney = getActiveTournament();
            if (!tourney) return;
            if (!isUserOrganizerOf(tourney)) {
                alert(`Endast turneringens arrangör (${tourney.organizer ? tourney.organizer.name : 'Admin'}) kan göra en ny lottning.`);
                openAuthModalWithRegisteredList();
                return;
            }
            if (confirm('Vill du göra en ny lottning? Spelordningen kommer att slumpas om för alla 8 spelare.')) {
                executeDraw(tourney);
            }
        });

        // Skapa ny turnering (Med arrangörsuppgifter och valfri Plats 1 placering)
        document.getElementById('formNewTournament').addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('inputTourneyName').value.trim();
            const format = document.querySelector('input[name="tourneyFormat"]:checked').value;
            const points = document.getElementById('selectPointSystem').value;
            const orgName = document.getElementById('inputOrganizerName') ? document.getElementById('inputOrganizerName').value.trim() : '';
            const orgPlays = document.getElementById('checkOrganizerPlays') ? document.getElementById('checkOrganizerPlays').checked : true;

            const newTourney = createNewTournament(name, format, points, { name: orgName }, orgPlays);
            closeModal('modalNewTournament');
            renderApp();
            switchTab('tabLobby');

            setTimeout(() => {
                openShareModal();
            }, 300);
        });

        // REGISTRERING HELT UTAN MAIL (BARA NAMN -> SLUMPAR 4-SIFFRIG KOD & SPARAS I TELEFONEN)
        const formQuickRegister = document.getElementById('formQuickRegisterName');
        if (formQuickRegister) {
            formQuickRegister.addEventListener('submit', (e) => {
                e.preventDefault();
                const nameInput = document.getElementById('quickRegisterNameInput');
                const name = nameInput ? nameInput.value.trim() : '';
                const tourney = getActiveTournament();
                if (tourney && registerPlayer(tourney, { name: name }, true)) {
                    if (nameInput) nameInput.value = '';
                }
            });
        }

        // BEKRÄFTELSEMODAL FÖR PIN-KOD (STÄNG KNAPP)
        const btnPinConfirmDone = document.getElementById('btnPinConfirmDone');
        if (btnPinConfirmDone) {
            btnPinConfirmDone.addEventListener('click', () => {
                closeModal('modalPinConfirmation');
            });
        }

        // MANUELL REGISTRERING (FÖR ARRANGÖR ATT TILLDELA PLATS UTAN MAIL)
        document.getElementById('formManualPlayer').addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('manualPlayerName').value.trim();

            if (!name) {
                alert('Vänligen ange spelarens namn.');
                return;
            }

            const tourney = getActiveTournament();
            if (tourney && registerPlayer(tourney, { name: name }, true)) {
                closeModal('modalManualPlayer');
            }
        });

        // TILLDELA REDAN REGISTRERAD SPELARE
        const btnAssignExisting = document.getElementById('btnAssignExistingPlayer');
        if (btnAssignExisting) {
            btnAssignExisting.addEventListener('click', () => {
                const select = document.getElementById('selectExistingPlayer');
                const playerId = select ? select.value : null;
                const regPlayer = (appState.registeredPlayers || []).find(p => p.id === playerId);
                const tourney = getActiveTournament();
                if (regPlayer && tourney) {
                    if (registerPlayer(tourney, {
                        name: regPlayer.name,
                        pin: regPlayer.pin
                    }, true)) {
                        closeModal('modalManualPlayer');
                    }
                }
            });
        }

        // INBJUDNINGSKANALER & ARRANGÖRSÅTKOMST
        function openShareModal() {
            const tourney = getActiveTournament();
            if (!tourney) return;
            document.getElementById('shareUrlInput').value = getInviteUrl(tourney);

            // Visa arrangörskod och arrangörsruta (visas om användaren är arrangör)
            const badgeCode = document.getElementById('badgeOrganizerCode');
            if (badgeCode) {
                badgeCode.textContent = `Kod: ${tourney.adminCode || 'PT-88'}`;
            }

            const orgBox = document.getElementById('modalOrganizerAccessBox');
            if (orgBox) {
                orgBox.style.display = isUserOrganizerOf(tourney) ? 'block' : 'none';
            }

            openModal('modalShare');
        }

        const btnCopyAdmin = document.getElementById('btnCopyAdminUrl');
        if (btnCopyAdmin) {
            btnCopyAdmin.addEventListener('click', () => {
                const tourney = getActiveTournament();
                if (!tourney) return;
                const adminUrl = getOrganizerUrl(tourney);
                copyTextToClipboard(adminUrl).then(() => {
                    btnCopyAdmin.innerHTML = '<span>✓</span> Arrangörslänk kopierad!';
                    setTimeout(() => {
                        btnCopyAdmin.innerHTML = '<span>🔗</span> Kopiera din arrangörslänk';
                    }, 2500);
                });
            });
        }

        document.getElementById('btnShareTournament').addEventListener('click', openShareModal);

        document.getElementById('btnShareMessenger').addEventListener('click', () => {
            const tourney = getActiveTournament();
            if (tourney) shareViaMessenger(tourney);
        });
        document.getElementById('modalBtnMessenger').addEventListener('click', () => {
            const tourney = getActiveTournament();
            if (tourney) shareViaMessenger(tourney);
        });

        document.getElementById('btnShareWhatsapp').addEventListener('click', () => {
            const tourney = getActiveTournament();
            if (tourney) shareViaWhatsApp(tourney);
        });
        document.getElementById('modalBtnWhatsapp').addEventListener('click', () => {
            const tourney = getActiveTournament();
            if (tourney) shareViaWhatsApp(tourney);
        });

        function handleCopyInviteLink() {
            const tourney = getActiveTournament();
            if (!tourney) return;
            const url = getInviteUrl(tourney);
            copyTextToClipboard(url).then(() => {
                const btn1 = document.getElementById('btnCopyInviteLink');
                const btn2 = document.getElementById('btnCopyShareUrl');
                if (btn1) btn1.textContent = 'Kopierad! ✓';
                if (btn2) btn2.textContent = 'Kopierad! ✓';
                setTimeout(() => {
                    if (btn1) btn1.innerHTML = '<span>📋</span> Kopiera inbjudningslänk';
                    if (btn2) btn2.textContent = 'Kopiera';
                }, 2000);
            });
        }

        document.getElementById('btnCopyInviteLink').addEventListener('click', handleCopyInviteLink);
        document.getElementById('btnCopyShareUrl').addEventListener('click', handleCopyInviteLink);

        // Matchresultat & Steppers
        document.getElementById('btnSaveScore').addEventListener('click', () => {
            if (!currentEditingMatch) return;
            const s1 = parseInt(document.getElementById('inputScore1').value, 10);
            const s2 = parseInt(document.getElementById('inputScore2').value, 10);

            if (!isNaN(s1) && !isNaN(s2)) {
                saveMatchScore(currentEditingMatch.id, s1, s2);
                closeModal('modalScore');
            }
        });

        document.getElementById('btnTeam1Plus').addEventListener('click', () => {
            const el = document.getElementById('inputScore1');
            el.value = parseInt(el.value || 0, 10) + 1;
        });
        document.getElementById('btnTeam1Minus').addEventListener('click', () => {
            const el = document.getElementById('inputScore1');
            el.value = Math.max(0, parseInt(el.value || 0, 10) - 1);
        });
        document.getElementById('btnTeam2Plus').addEventListener('click', () => {
            const el = document.getElementById('inputScore2');
            el.value = parseInt(el.value || 0, 10) + 1;
        });
        document.getElementById('btnTeam2Minus').addEventListener('click', () => {
            const el = document.getElementById('inputScore2');
            el.value = Math.max(0, parseInt(el.value || 0, 10) - 1);
        });

        // Stäng-knappar för alla modaler
        document.querySelectorAll('.modal-close, .btn-modal-cancel').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.remove('open'));
            });
        });

        // INLOGGNING (ARRANGÖR ELLER SPELARE)
        const cardRoleAdmin = document.getElementById('cardRoleAdmin');
        const cardRolePlayer = document.getElementById('cardRolePlayer');
        const authRoleSelected = document.getElementById('authRoleSelected');
        const authPinGroup = document.getElementById('authPinGroup');
        const authPlayerQuickSelectGroup = document.getElementById('authPlayerQuickSelectGroup');
        const selectAuthRegisteredPlayer = document.getElementById('selectAuthRegisteredPlayer');
        const btnSubmitAuth = document.getElementById('btnSubmitAuth');
        const btnLogoutUser = document.getElementById('btnLogoutUser');
        const btnContinueAsGuest = document.getElementById('btnContinueAsGuest');
        const btnGuestLogin = document.getElementById('btnGuestBannerLogin');

        const authPlayerPinGroup = document.getElementById('authPlayerPinGroup');

        function setAuthRole(role) {
            authRoleSelected.value = role;
            if (role === 'admin') {
                cardRoleAdmin.classList.add('selected');
                cardRolePlayer.classList.remove('selected');
                if (authPlayerPinGroup) authPlayerPinGroup.style.display = 'none';
                authPinGroup.style.display = 'block';
                if (authPlayerQuickSelectGroup) authPlayerQuickSelectGroup.style.display = 'none';
                btnSubmitAuth.textContent = 'Logga in som Arrangör 👔';
            } else {
                cardRolePlayer.classList.add('selected');
                cardRoleAdmin.classList.remove('selected');
                if (authPlayerPinGroup) authPlayerPinGroup.style.display = 'block';
                authPinGroup.style.display = 'none';
                if (authPlayerQuickSelectGroup) authPlayerQuickSelectGroup.style.display = 'block';
                btnSubmitAuth.textContent = 'Logga in som Spelare 🎾';
            }
        }

        if (cardRoleAdmin && cardRolePlayer) {
            cardRoleAdmin.addEventListener('click', () => setAuthRole('admin'));
            cardRolePlayer.addEventListener('click', () => setAuthRole('player'));
        }

        function openAuthModalWithRegisteredList() {
            const currentRole = (appState.currentUser && appState.currentUser.role === 'admin') ? 'admin' : 'player';
            setAuthRole(currentRole);

            document.getElementById('authUserName').value = appState.currentUser ? appState.currentUser.name : '';
            const pinInput = document.getElementById('authPlayerPin');
            if (pinInput) pinInput.value = (appState.currentUser && appState.currentUser.pin) ? appState.currentUser.pin : '';

            // Fyll i registrerade spelare i snabbvalsmenyn för spelar-inloggning
            if (selectAuthRegisteredPlayer) {
                const tourney = getActiveTournament();
                const playersToList = (tourney && tourney.players && tourney.players.length > 0)
                    ? tourney.players
                    : (appState.registeredPlayers || []);

                if (playersToList.length > 0) {
                    selectAuthRegisteredPlayer.innerHTML = '<option value="">-- Välj ditt namn eller fyll i nedan --</option>' +
                        playersToList.map(p => {
                            const name = typeof p === 'string' ? p : p.name;
                            return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
                        }).join('');
                } else {
                    selectAuthRegisteredPlayer.innerHTML = '<option value="">-- Inga registrerade spelare ännu --</option>';
                }
            }

            // Uppdatera info om man redan är inloggad
            renderUserStatus();
            openModal('modalAuth');
        }

        if (selectAuthRegisteredPlayer) {
            selectAuthRegisteredPlayer.addEventListener('change', () => {
                const playerName = selectAuthRegisteredPlayer.value;
                if (playerName) {
                    document.getElementById('authUserName').value = playerName;
                    const pinInput = document.getElementById('authPlayerPin');
                    if (pinInput) {
                        pinInput.value = '';
                        pinInput.focus();
                    }
                }
            });
        }

        document.getElementById('btnUserAuth').addEventListener('click', () => {
            const guestPrompt = document.getElementById('authNoticeGuestPrompt');
            if (guestPrompt) guestPrompt.style.display = 'none';
            openAuthModalWithRegisteredList();
        });

        if (btnGuestLogin) {
            btnGuestLogin.addEventListener('click', () => {
                const guestPrompt = document.getElementById('authNoticeGuestPrompt');
                if (guestPrompt) guestPrompt.style.display = 'none';
                openAuthModalWithRegisteredList();
            });
        }

        if (btnContinueAsGuest) {
            btnContinueAsGuest.addEventListener('click', () => {
                closeModal('modalAuth');
            });
        }

        if (btnLogoutUser) {
            btnLogoutUser.addEventListener('click', () => {
                logoutUser();
                closeModal('modalAuth');
            });
        }

        document.getElementById('formAuth').addEventListener('submit', (e) => {
            e.preventDefault();
            const role = authRoleSelected.value;
            const name = document.getElementById('authUserName').value.trim() || (role === 'admin' ? 'Arrangör' : 'Spelare');
            const adminPin = (document.getElementById('authAdminPin') ? document.getElementById('authAdminPin').value.trim() : '');

            const tourney = getActiveTournament();

            if (role === 'admin') {
                let isAuthorized = false;

                if (tourney) {
                    const cleanPin = adminPin.toUpperCase().replace(/\s+/g, '');
                    const cleanCode = (tourney.adminCode || '').toUpperCase().replace(/\s+/g, '');

                    if (cleanPin && (cleanPin === cleanCode || cleanPin === cleanCode.replace('PT-', ''))) {
                        isAuthorized = true;
                    } else if (cleanPin && tourney.adminKey && cleanPin === tourney.adminKey.toUpperCase()) {
                        isAuthorized = true;
                    } else if (isUserOrganizerOf(tourney)) {
                        isAuthorized = true;
                    }
                } else {
                    isAuthorized = true;
                }

                if (!isAuthorized) {
                    alert(`Ogiltig arrangörskod för "${tourney ? tourney.name : 'turneringen'}". Ange arrangörskoden (t.ex. ${tourney ? (tourney.adminCode || 'PT-xx') : 'PT-xx'}) eller öppna din personliga arrangörslänk.`);
                    return;
                }

                // Spara nyckeln permanent på denna enhet
                if (tourney && tourney.adminKey) {
                    saveAdminKeyForTourney(tourney.id, tourney.adminKey);
                }

                appState.currentUser = {
                    id: (tourney && tourney.organizer && tourney.organizer.id) ? tourney.organizer.id : ('admin_' + Date.now()),
                    name: (tourney && tourney.organizer && tourney.organizer.name) ? tourney.organizer.name : name,
                    role: 'admin',
                    tourneyKey: tourney ? tourney.adminKey : null
                };
            } else {
                // Spelarinloggning: Verifiera med spelarens personliga 4-siffriga PIN-kod
                const playerPin = (document.getElementById('authPlayerPin') ? document.getElementById('authPlayerPin').value.trim() : '');

                // Hitta spelaren i aktiva turneringen eller i spelarregistret
                let foundPlayer = null;
                if (tourney && tourney.players) {
                    foundPlayer = tourney.players.find(p => {
                        const pName = typeof p === 'string' ? p : p.name;
                        return pName.toLowerCase() === name.toLowerCase();
                    });
                }
                if (!foundPlayer && appState.registeredPlayers) {
                    foundPlayer = appState.registeredPlayers.find(p => p.name.toLowerCase() === name.toLowerCase());
                }

                if (!foundPlayer) {
                    alert(`Kunde inte hitta någon anmäld spelare med namnet "${name}". Kontrollera stavningen eller fyll i ditt namn i väntrummet.`);
                    return;
                }

                const expectedPin = (typeof foundPlayer === 'object' && foundPlayer.pin) ? String(foundPlayer.pin).trim() : '';

                if (expectedPin && playerPin !== expectedPin) {
                    alert(`Felaktig inloggningskod för "${name}". Ange din 4-siffriga kod.`);
                    return;
                }

                appState.currentUser = {
                    id: (typeof foundPlayer === 'object' && foundPlayer.id) ? foundPlayer.id : ('user_' + Date.now()),
                    name: (typeof foundPlayer === 'object') ? foundPlayer.name : foundPlayer,
                    pin: expectedPin,
                    role: 'player'
                };
            }

            saveUser();
            closeModal('modalAuth');
            renderUserStatus();
            renderApp();
            playAudioTone(523.25, 0.15);
        });
    }

    // =========================================================================
    // 13. INITIALISERING
    // =========================================================================

    document.addEventListener('DOMContentLoaded', () => {
        loadState();
        setupEventListeners();

        // Standard: Game-räkning vid nyskapad standardturnering (helt utan mail)
        if (appState.tournaments.length === 0 && appState.deletedTournaments.length === 0) {
            createNewTournament(
                'Pinta Padel Tour – Sala',
                'option1',
                'games',
                { name: 'Ulrik' },
                true
            );
        } else {
            initCloudSync();
        }

        renderApp();
    });

})();
