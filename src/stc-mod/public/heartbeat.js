/* eslint-env browser */
/**
 * STC-MOD Heartbeat Client
 *
 * Sends periodic heartbeat requests to update user activity timestamp.
 * This file is loaded independently and does not modify official code.
 */

(function () {
    'use strict';

    // Configuration
    const HEARTBEAT_INTERVAL = 1 * 60 * 1000; // 1 minute
    const HEARTBEAT_ENDPOINT = '/api/stc/users/heartbeat';

    /**
     * Send a heartbeat request to the server
     */
    async function sendHeartbeat() {
        try {
            const response = await fetch(HEARTBEAT_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            if (!response.ok && response.status !== 204) {
                console.warn('[STC-MOD] Heartbeat failed:', response.status);
            }
        } catch (error) {
            console.error('[STC-MOD] Heartbeat error:', error);
        }
    }

    /**
     * Initialize heartbeat timer
     */
    function initHeartbeat() {
        // Send initial heartbeat
        sendHeartbeat();

        // Setup periodic heartbeat
        setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

        console.log(`[STC-MOD] Heartbeat initialized (interval: ${HEARTBEAT_INTERVAL / 1000}s)`);
    }

    // Start heartbeat when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initHeartbeat);
    } else {
        initHeartbeat();
    }
})();
