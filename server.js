require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { FedaPay, Transaction, Webhook } = require("fedapay");

const FEDAPAY_API_KEY = process.env.FEDAPAY_API_KEY;
const FEDAPAY_ENVIRONMENT = process.env.FEDAPAY_ENVIRONMENT || "sandbox";
const FEDAPAY_WEBHOOK_SECRET = process.env.FEDAPAY_WEBHOOK_SECRET;

if (!FEDAPAY_API_KEY) {
    console.warn("ATTENTION : variable FEDAPAY_API_KEY manquante.");
}

FedaPay.setApiKey(FEDAPAY_API_KEY);
FedaPay.setEnvironment(FEDAPAY_ENVIRONMENT);


const BREVO_API_KEY = process.env.NEXORA_BREVO_API_KEY;
const SENDER_EMAIL = process.env.NEXORA_SENDER_EMAIL || "banque.nexora@gmail.com";

if (!BREVO_API_KEY) {
    console.warn("ATTENTION : variable NEXORA_BREVO_API_KEY manquante.");
}

async function sendBrevoEmail({ to, subject, text, html }) {
    if (!BREVO_API_KEY) {
        throw new Error("NEXORA_BREVO_API_KEY manquante.");
    }

    const payload = JSON.stringify({
        sender: {
            name: "NEXORA",
            email: SENDER_EMAIL
        },
        to: [
            {
                email: to
            }
        ],
        subject,
        textContent: text,
        htmlContent: html
    });

    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
            "accept": "application/json",
            "api-key": BREVO_API_KEY,
            "content-type": "application/json"
        },
        body: payload
    });

    const body = await response.text();

    if (!response.ok) {
        throw new Error(
            `Brevo API HTTP ${response.status}: ${body.slice(0, 500)}`
        );
    }

    let result = {};
    try {
        result = body ? JSON.parse(body) : {};
    } catch (_) {}

    console.log("Email Brevo envoyé avec succès. messageId :", result.messageId || "non fourni");

    return result;
}

async function sendVerificationEmail(to, code) {

    console.log("Tentative d'envoi du code de verification a : " + to);

    const result = await sendBrevoEmail({
        to,
        subject: "Votre code de vérification NEXORA",
        text:
            `Votre code de vérification NEXORA est : ${code}\n\n` +
            `Ce code est valable pendant 10 minutes.\n` +
            `Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.`,
        html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
                <h2>NEXORA</h2>
                <p>Votre code de vérification est :</p>
                <div style="font-size:32px;font-weight:bold;letter-spacing:8px">
                    ${code}
                </div>
                <p>Ce code est valable pendant <strong>10 minutes</strong>.</p>
                <p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.</p>
            </div>
        `
    });

    return result;
}

function formaterDateHeureServeur(date) {
    const formatter = new Intl.DateTimeFormat("fr-FR", {
        timeZone: "Europe/Paris",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    });
    const parts = formatter.formatToParts(date);
    const get = (type) => {
        const found = parts.find((p) => p.type === type);
        return found ? found.value : "";
    };
    return `${get("day")}/${get("month")}/${get("year")} à ${get("hour")}:${get("minute")}`;
}

async function sendVirementEmail(to, details) {

    const dateHeure = formaterDateHeureServeur(new Date());

    const titre =
        details.sens === "envoye"
            ? "Virement envoyé"
            : "Virement reçu";

    const phrase =
        details.sens === "envoye"
            ? `Vous avez envoyé un virement à ${details.contrepartie} d'un montant de ${details.montant} ${details.devise}.`
            : `Vous avez reçu un virement de ${details.contrepartie} d'un montant de ${details.montant} ${details.devise}.`;

    return sendBrevoEmail({
        to,
        subject: `NEXORA — ${titre}`,
        text:
            `${phrase}\n\n` +
            `Motif : ${details.motif}\n` +
            `Date : ${dateHeure}\n` +
            `Référence : ${details.reference}`,
        html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
                <h2>NEXORA</h2>
                <h3>${titre}</h3>
                <p>${phrase}</p>
                <table style="margin-top:16px;font-size:14px">
                    <tr><td style="color:#7c8798;padding:4px 12px 4px 0">Motif</td><td><strong>${details.motif}</strong></td></tr>
                    <tr><td style="color:#7c8798;padding:4px 12px 4px 0">Date</td><td><strong>${dateHeure}</strong></td></tr>
                    <tr><td style="color:#7c8798;padding:4px 12px 4px 0">Référence</td><td><strong>${details.reference}</strong></td></tr>
                </table>
            </div>
        `
    });
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const DB = path.join(__dirname, "nexora.db");

function sqlite(sql, params = []) {
    return new Promise((resolve, reject) => {

        const args = [];

        for (const p of params) {
            args.push(String(p));
        }

        execFile(
            "sqlite3",
            ["-json", DB, sql],
            (error, stdout, stderr) => {

                if (error) {
                    reject(new Error(stderr || error.message));
                    return;
                }

                try {
                    resolve(stdout.trim() ? JSON.parse(stdout) : []);
                } catch {
                    resolve([]);
                }
            }
        );
    });
}

async function initDB() {

    const sql = `
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS utilisateurs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT NOT NULL,
        prenom TEXT NOT NULL,
        pays TEXT NOT NULL,
        indicatif TEXT NOT NULL,
        telephone TEXT NOT NULL UNIQUE,
        date_naissance TEXT NOT NULL,
        adresse TEXT,
        ville TEXT,
        type_document TEXT,
        numero_document TEXT,
        type_identifiant_bancaire TEXT NOT NULL,
        identifiant_bancaire TEXT NOT NULL,
        mot_de_passe_hash TEXT NOT NULL,
        compte_verifie INTEGER DEFAULT 0,
        statut TEXT DEFAULT 'actif',
        date_creation TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_utilisateurs_telephone
    ON utilisateurs(telephone);

    CREATE INDEX IF NOT EXISTS idx_utilisateurs_identifiant_bancaire
    ON utilisateurs(identifiant_bancaire);
    `;

    await sqlite(sql);

    await migrerTableUtilisateurs();

    console.log("Base NEXORA initialisée.");
}

const COLONNES_UTILISATEURS_ATTENDUES = [
    { nom: "email", def: "TEXT" },
    { nom: "email_code", def: "TEXT" },
    { nom: "email_code_expiry", def: "DATETIME" },
    { nom: "email_code_attempts", def: "INTEGER DEFAULT 0" },
    { nom: "abonnement_actif", def: "INTEGER DEFAULT 0" },
    { nom: "abonnement_expiration", def: "TEXT" },
    { nom: "type_compte", def: "TEXT DEFAULT 'standard'" }
];

async function migrerTableUtilisateurs() {

    const colonnesActuelles = await sqlite("PRAGMA table_info(utilisateurs)");
    const nomsExistants = colonnesActuelles.map(col => col.name);

    for (const colonne of COLONNES_UTILISATEURS_ATTENDUES) {
        if (!nomsExistants.includes(colonne.nom)) {
            try {
                await sqlite(`ALTER TABLE utilisateurs ADD COLUMN ${colonne.nom} ${colonne.def}`);
                console.log(`✅ Colonne ajoutée : ${colonne.nom}`);
            } catch (error) {
                console.warn(`❌ Erreur ajout ${colonne.nom} :`, error.message);
            }
        }
    }
}

function hashPassword(password) {

    const salt = crypto.randomBytes(16).toString("hex");

    const hash = crypto
        .scryptSync(password, salt, 64)
        .toString("hex");

    return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    var parts = String(stored || "").split(":");
    if (parts.length !== 2) return false;
    var salt = parts[0];
    var hash = parts[1];
    var check = crypto.scryptSync(password, salt, 64).toString("hex");
    var a = Buffer.from(hash, "hex");
    var b = Buffer.from(check, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

var sessions = new Map();

function createSession(userId) {
    var token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, {
        userId: userId,
        expiry: Date.now() + (7 * 24 * 60 * 60 * 1000)
    });
    return token;
}

function getSessionUserId(token) {
    if (!token) return null;
    var session = sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiry) {
        sessions.delete(token);
        return null;
    }
    return session.userId;
}


/*
 * ============================================================
 * TABLE DES PAIEMENTS PREMIUM
 * ============================================================
 *
 * Cette table permet d'empêcher qu'une même transaction
 * FedaPay soit traitée plusieurs fois.
 */

async function initialiserTablePaiementsPremium() {

    try {

        await sqlite(`
            CREATE TABLE IF NOT EXISTS paiements_premium (

                id INTEGER PRIMARY KEY AUTOINCREMENT,

                fedapay_transaction_id TEXT NOT NULL UNIQUE,

                email TEXT NOT NULL,

                montant INTEGER NOT NULL,

                devise TEXT NOT NULL,

                statut TEXT NOT NULL,

                date_paiement TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP

            )
        `);

        console.log(
            "✅ Table paiements_premium vérifiée."
        );

    } catch (error) {

        console.error(
            "❌ Erreur table paiements_premium :",
            error.message
        );

    }

}

async function getUserPublicById(id) {

    var rows = await sqlite(
        "SELECT id, nom, prenom, pays, indicatif, telephone, email, type_identifiant_bancaire, compte_verifie, statut, type_compte, abonnement_actif, abonnement_expiration, date_creation FROM utilisateurs WHERE id = " + Number(id) + " LIMIT 1"
    );

    const utilisateur = rows[0] || null;

    if(!utilisateur){
        return null;
    }

    const expiration = utilisateur.abonnement_expiration
        ? new Date(utilisateur.abonnement_expiration)
        : null;

    const premiumValide =
        utilisateur.type_compte === "illimite" &&
        Number(utilisateur.abonnement_actif) === 1 &&
        expiration &&
        Number.isFinite(expiration.getTime()) &&
        expiration.getTime() > Date.now();

    /*
     * Le serveur est la source de vérité.
     * Si l'abonnement est expiré, on repasse automatiquement
     * le compte en standard.
     */
    if(!premiumValide){

        if(
            utilisateur.type_compte === "illimite" ||
            Number(utilisateur.abonnement_actif) === 1
        ){
            await sqlite(
                "UPDATE utilisateurs SET type_compte = 'standard', abonnement_actif = 0 WHERE id = " +
                Number(id)
            );
        }

        utilisateur.type_compte = "standard";
        utilisateur.abonnement_actif = 0;

    }else{

        utilisateur.type_compte = "illimite";
        utilisateur.abonnement_actif = 1;
    }

    return utilisateur;
}

function sendJSON(res, status, data) {

    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
    });

    res.end(JSON.stringify(data));
}

function readBody(req) {

    return new Promise((resolve, reject) => {

        let body = "";

        req.on("data", chunk => {
            body += chunk;
        });

        req.on("end", () => {

            try {
                resolve(JSON.parse(body || "{}"));
            } catch {
                reject(new Error("JSON invalide"));
            }

        });

        req.on("error", reject);
    });
}

function readRawBody(req) {

    return new Promise((resolve, reject) => {

        let chunks = [];

        req.on("data", chunk => {
            chunks.push(chunk);
        });

        req.on("end", () => {
            resolve(Buffer.concat(chunks));
        });

        req.on("error", reject);
    });
}

async function createUser(data) {

    const required = [
        "nom",
        "prenom",
        "email",
        "pays",
        "indicatif",
        "telephone",
        "date_naissance",
        "type_identifiant_bancaire",
        "identifiant_bancaire",
        "mot_de_passe"
    ];

    for (const field of required) {

        if (!data[field] ||
            String(data[field]).trim() === "") {

            throw new Error(
                `Champ obligatoire manquant : ${field}`
            );
        }
    }

    const email =
        String(data.email || "").trim().toLowerCase();

    if (!email || !email.includes("@")) {
        throw new Error("Adresse Gmail invalide.");
    }

    const telephone =
        `${data.indicatif}${data.telephone}`;

    const existingEmail = await sqlite(
        `SELECT id
         FROM utilisateurs
         WHERE email = '${email.replace(/'/g, "''")}'
         LIMIT 1`
    );

    if (existingEmail.length) {
        throw new Error("Un compte existe déjà avec cette adresse Gmail.");
    }

    const existing = await sqlite(
        `SELECT id
         FROM utilisateurs
         WHERE telephone = '${telephone.replace(/'/g, "''")}'
         LIMIT 1`
    );

    if (existing.length) {
        throw new Error(
            "Un compte existe déjà avec ce numéro."
        );
    }

    const passwordHash =
        hashPassword(data.mot_de_passe);

    const emailCode =
        String(crypto.randomInt(100000, 1000000));

    const emailCodeExpiry =
        Date.now() + (10 * 60 * 1000);

    const values = [
        data.nom,
        data.prenom,
        data.pays,
        data.indicatif,
        telephone,
        data.date_naissance,
        data.adresse || "",
        data.ville || "",
        data.type_document || "",
        data.numero_document || "",
        data.type_identifiant_bancaire,
        data.identifiant_bancaire,
        passwordHash
    ];

    const escaped = values.map(
        value =>
            `'${String(value).replace(/'/g, "''")}'`
    );

    await sqlite(`
        INSERT INTO utilisateurs (
            nom,
            prenom,
            pays,
            indicatif,
            telephone,
            date_naissance,
            adresse,
            ville,
            type_document,
            numero_document,
            type_identifiant_bancaire,
            identifiant_bancaire,
            mot_de_passe_hash,
            email,
            email_code,
            email_code_expiry,
            email_code_attempts,
            type_compte
        )
        VALUES (
            ${escaped.join(",")},
            '${email.replace(/'/g, "''")}',
            '${emailCode}',
            ${emailCodeExpiry},
            0,
            'standard'
        )
    `);

    sendVerificationEmail(email, emailCode).catch(function (error) {
        console.error("Erreur envoi email de verification :", error.message);
    });

    const result = await sqlite(`
        SELECT
            id,
            nom,
            prenom,
            pays,
            indicatif,
            telephone,
            email,
            type_identifiant_bancaire,
            compte_verifie,
            statut,
            type_compte,
            date_creation
        FROM utilisateurs
        WHERE telephone = '${telephone.replace(/'/g, "''")}'
        LIMIT 1
    `);

    return result[0];
}

async function handleRequest(req, res) {

    if (req.method === "OPTIONS") {

        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        });

        res.end();
        return;
    }

    if (req.url === "/api/health") {

        sendJSON(res, 200, {
            ok: true,
            service: "NEXORA",
            database: fs.existsSync(DB)
        });

        return;
    }

    if (req.url === "/api/notifier-virement" &&
        req.method === "POST") {

        try {

            const data = await readBody(req);

            const email =
                String(data.email || "").trim().toLowerCase();

            if (!email || !email.includes("@")) {
                throw new Error("Adresse email du destinataire invalide.");
            }

            if (!data.montant || Number(data.montant) <= 0) {
                throw new Error("Montant invalide.");
            }

            await sendVirementEmail(email, {
                sens: data.sens || "recu",
                contrepartie: data.contrepartie || "un utilisateur NEXORA",
                montant: data.montant,
                devise: data.devise || "FCFA",
                motif: data.motif || "Non précisé",
                reference: data.reference || ""
            });

            sendJSON(res, 200, {
                success: true,
                message: "Notification envoyee."
            });

        } catch (error) {

            sendJSON(res, 400, {
                success: false,
                message: error.message
            });

        }

        return;
    }



    if (req.url === "/api/inscription" &&
        req.method === "POST") {

        try {

            const data = await readBody(req);

            const user = await createUser(data);

            sendJSON(res, 201, {
                success: true,
                message: "Compte NEXORA créé.",
                utilisateur: user
            });

        } catch (error) {

            sendJSON(res, 400, {
                success: false,
                message: error.message
            });

        }

        return;
    }

    if (req.url === "/api/renvoi-code" &&
        req.method === "POST") {

        try {

            const data = await readBody(req);

            const email =
                String(data.email || "").trim().toLowerCase();

            if (!email) {
                throw new Error("Adresse Gmail obligatoire.");
            }

            const users = await sqlite(`
                SELECT id
                FROM utilisateurs
                WHERE email = '${email.replace(/'/g, "''")}'
                LIMIT 1
            `);

            if (!users.length) {
                throw new Error("Aucun compte associé à cette adresse.");
            }

            const emailCode =
                String(crypto.randomInt(100000, 1000000));

            const emailCodeExpiry =
                Date.now() + (10 * 60 * 1000);

            await sqlite(`
                UPDATE utilisateurs
                SET email_code = '${emailCode}',
                    email_code_expiry = ${emailCodeExpiry},
                    email_code_attempts = 0
                WHERE email = '${email.replace(/'/g, "''")}'
            `);

            sendVerificationEmail(email, emailCode).catch(function (error) {
                console.error("Erreur envoi email (renvoi) :", error.message);
            });

            sendJSON(res, 200, {
                success: true,
                message: "Un nouveau code a été envoyé."
            });

        } catch (error) {

            sendJSON(res, 400, {
                success: false,
                message: error.message
            });

        }

        return;
    }


    if (req.url === "/api/verification-email" &&
        req.method === "POST") {

        try {

            const data = await readBody(req);

            const email =
                String(data.email || "")
                    .trim()
                    .toLowerCase();

            const code =
                String(data.code || "")
                    .trim();

            if (!email || !code) {
                throw new Error(
                    "Adresse Gmail et code obligatoires."
                );
            }

            if (!/^\d{6}$/.test(code)) {
                throw new Error(
                    "Le code doit contenir exactement 6 chiffres."
                );
            }

            const users = await sqlite(`
                SELECT
                    id,
                    email,
                    email_code,
                    email_code_expiry,
                    email_code_attempts
                FROM utilisateurs
                WHERE email = '${email.replace(/'/g, "''")}'
                LIMIT 1
            `);

            if (!users.length) {
                throw new Error(
                    "Compte introuvable."
                );
            }

            const user = users[0];

            const attempts =
                Number(user.email_code_attempts || 0);

            if (attempts >= 5) {
                throw new Error(
                    "Trop de tentatives. Demandez un nouveau code."
                );
            }

            if (
                !user.email_code_expiry ||
                Date.now() > Number(user.email_code_expiry)
            ) {
                throw new Error(
                    "Ce code a expiré. Demandez un nouveau code."
                );
            }

            if (code !== String(user.email_code)) {

                await sqlite(`
                    UPDATE utilisateurs
                    SET email_code_attempts = ${attempts + 1}
                    WHERE id = ${Number(user.id)}
                `);

                throw new Error(
                    "Code de vérification incorrect."
                );
            }

            await sqlite(`
                UPDATE utilisateurs
                SET
                    compte_verifie = 1,
                    email_code = NULL,
                    email_code_expiry = NULL,
                    email_code_attempts = 0
                WHERE id = ${Number(user.id)}
            `);

            const verifiedUser = await sqlite(`
                SELECT
                    id,
                    nom,
                    prenom,
                    pays,
                    indicatif,
                    telephone,
                    email,
                    type_identifiant_bancaire,
                    compte_verifie,
                    statut,
                    type_compte,
                    date_creation
                FROM utilisateurs
                WHERE id = ${Number(user.id)}
                LIMIT 1
            `);

            const token = createSession(user.id);

            sendJSON(res, 200, {
                success: true,
                message: "Adresse Gmail verifiee avec succes.",
                token: token,
                utilisateur: verifiedUser[0]
            });

        } catch (error) {

            sendJSON(res, 400, {
                success: false,
                message: error.message
            });

        }

        return;
    }

    if (req.url === "/api/utilisateurs" &&
        req.method === "GET") {

        try {

            const users = await sqlite(`
                SELECT
                    id,
                    nom,
                    prenom,
                    pays,
                    indicatif,
                    telephone,
                    type_identifiant_bancaire,
                    compte_verifie,
                    statut,
                    type_compte,
                    date_creation
                FROM utilisateurs
                ORDER BY id DESC
            `);

            sendJSON(res, 200, users);

        } catch (error) {

            sendJSON(res, 500, {
                success: false,
                message: error.message
            });

        }

        return;
    }

    if (req.url === "/api/connexion" && req.method === "POST") {

        try {

            const data = await readBody(req);

            const email = String(data.email || "").trim().toLowerCase();
            const password = String(data.mot_de_passe || "");

            if (!email || !password) {
                throw new Error("Gmail et mot de passe obligatoires.");
            }

            const rows = await sqlite(
                "SELECT id, mot_de_passe_hash, compte_verifie FROM utilisateurs WHERE email = '" + email.replace(/'/g, "''") + "' LIMIT 1"
            );

            if (!rows.length) {
                throw new Error("Gmail ou mot de passe incorrect.");
            }

            const row = rows[0];

            const valid = verifyPassword(password, row.mot_de_passe_hash);

            if (!valid) {
                throw new Error("Gmail ou mot de passe incorrect.");
            }

            if (Number(row.compte_verifie) !== 1) {
                throw new Error("Compte non verifie. Confirmez votre adresse Gmail.");
            }

            const token = createSession(row.id);
            const utilisateur = await getUserPublicById(row.id);

            sendJSON(res, 200, {
                success: true,
                token: token,
                utilisateur: utilisateur
            });

        } catch (error) {

            sendJSON(res, 401, {
                success: false,
                message: error.message
            });

        }

        return;
    }

    if (req.url === "/api/session" && req.method === "GET") {

        try {

            const header = req.headers["authorization"] || "";
            const token = header.indexOf("Bearer ") === 0 ? header.slice(7) : "";

            const userId = getSessionUserId(token);

            if (!userId) {
                throw new Error("Session invalide.");
            }

            const utilisateur = await getUserPublicById(userId);

            if (!utilisateur) {
                throw new Error("Compte introuvable.");
            }

            sendJSON(res, 200, {
                success: true,
                utilisateur: utilisateur
            });

        } catch (error) {

            sendJSON(res, 401, {
                success: false,
                message: error.message
            });

        }

        return;
    }

    if (req.url === "/api/abonnement/payer" && req.method === "POST") {

        try {

            const header = req.headers["authorization"] || "";
            const token = header.indexOf("Bearer ") === 0 ? header.slice(7) : "";

            const userId = getSessionUserId(token);

            if (!userId) {
                throw new Error("Session invalide.");
            }

            const utilisateur = await getUserPublicById(userId);

            if (!utilisateur) {
                throw new Error("Compte introuvable.");
            }

            const transaction = await Transaction.create({
                description: "Abonnement Premium NEXORA - 1 mois",
                amount: 2400,
                currency: { iso: "XOF" },
                callback_url: "https://tondomaine.com/abonnement/confirmation",
                customer: {
                    firstname: utilisateur.prenom,
                    lastname: utilisateur.nom,
                    email: utilisateur.email
                }
            });

            const fedapayToken = await transaction.generateToken();

            sendJSON(res, 200, {
                success: true,
                url: fedapayToken.url
            });

        } catch (error) {

            console.error(error);

            sendJSON(res, 500, {
                success: false,
                message: "Erreur lors de la creation du paiement."
            });

        }

        return;
    }

    if (req.url === "/api/compte/supprimer" && req.method === "POST") {

        try {

            const header = req.headers["authorization"] || "";
            const token = header.indexOf("Bearer ") === 0 ? header.slice(7) : "";

            const userId = getSessionUserId(token);

            if (!userId) {
                throw new Error("Session invalide.");
            }

            await sqlite("DELETE FROM utilisateurs WHERE id = " + Number(userId));

            sessions.delete(token);

            sendJSON(res, 200, {
                success: true,
                message: "Compte supprime."
            });

        } catch (error) {

            sendJSON(res, 400, {
                success: false,
                message: error.message
            });

        }

        return;
    }

    if (req.url === "/api/webhooks/fedapay" && req.method === "POST") {

        try {

            const rawBody = await readRawBody(req);
            const signature = req.headers["x-fedapay-signature"];

            const event = Webhook.constructEvent(
                rawBody,
                signature,
                FEDAPAY_WEBHOOK_SECRET
            );

            if (event.name === "transaction.approved") {

                const entity = event.entity || {};

                /*
                 * =====================================================
                 * SECURITE PREMIUM
                 * =====================================================
                 */

                const transactionId =
                    String(entity.id || "").trim();

                const email =
                    String(
                        entity.customer &&
                        entity.customer.email
                            ? entity.customer.email
                            : ""
                    )
                    .trim()
                    .toLowerCase();

                const montant =
                    Number(entity.amount);

                const devise =
                    String(
                        entity.currency &&
                        entity.currency.iso
                            ? entity.currency.iso
                            : ""
                    )
                    .trim()
                    .toUpperCase();

                const description =
                    String(entity.description || "").trim();

                /*
                 * L'identifiant FedaPay est obligatoire.
                 */

                if (!transactionId) {
                    throw new Error(
                        "Webhook Premium refusé : identifiant transaction absent."
                    );
                }

                if (!email) {
                    throw new Error(
                        "Webhook Premium refusé : email absent."
                    );
                }

                if (montant !== 2400) {
                    throw new Error(
                        "Webhook Premium refusé : montant incorrect."
                    );
                }

                if (devise !== "XOF") {
                    throw new Error(
                        "Webhook Premium refusé : devise incorrecte."
                    );
                }

                if (
                    description !==
                    "Abonnement Premium NEXORA - 1 mois"
                ) {
                    throw new Error(
                        "Webhook Premium refusé : description incorrecte."
                    );
                }

                /*
                 * =====================================================
                 * PROTECTION CONTRE LE DOUBLE TRAITEMENT
                 * =====================================================
                 */

                const paiementExistant =
                    await sqlite(
                        "SELECT id, statut FROM paiements_premium " +
                        "WHERE fedapay_transaction_id = '" +
                        transactionId.replace(/'/g, "''") +
                        "' LIMIT 1"
                    );

                if (paiementExistant[0]) {

                    console.log(
                        "ℹ️ Transaction Premium déjà traitée :",
                        transactionId
                    );

                    sendJSON(res, 200, {
                        received: true,
                        already_processed: true
                    });

                    return;
                }

                /*
                 * =====================================================
                 * VERIFICATION DU COMPTE
                 * =====================================================
                 */

                const utilisateurs =
                    await sqlite(
                        "SELECT id FROM utilisateurs WHERE email = '" +
                        email.replace(/'/g, "''") +
                        "' LIMIT 1"
                    );

                if (!utilisateurs[0]) {
                    throw new Error(
                        "Webhook Premium refusé : compte introuvable."
                    );
                }

                /*
                 * =====================================================
                 * ENREGISTREMENT DU PAIEMENT
                 * =====================================================
                 */

                await sqlite(`
                    INSERT INTO paiements_premium (
                        fedapay_transaction_id,
                        email,
                        montant,
                        devise,
                        statut
                    )
                    VALUES (
                        '${transactionId.replace(/'/g, "''")}',
                        '${email.replace(/'/g, "''")}',
                        2400,
                        'XOF',
                        'approved'
                    )
                `);

                /*
                 * =====================================================
                 * ACTIVATION PREMIUM
                 * =====================================================
                 */

                /*
                 * =====================================================
                 * CALCUL DE L'EXPIRATION PREMIUM
                 * =====================================================
                 *
                 * Si l'utilisateur possède encore du Premium,
                 * le nouveau mois est ajouté à son expiration actuelle.
                 *
                 * Sinon, le nouveau mois commence maintenant.
                 */

                const utilisateursPremium =
                    await sqlite(
                        "SELECT abonnement_expiration " +
                        "FROM utilisateurs WHERE email = '" +
                        email.replace(/'/g, "''") +
                        "' LIMIT 1"
                    );

                let baseExpiration = new Date();

                if (
                    utilisateursPremium[0] &&
                    utilisateursPremium[0].abonnement_expiration
                ) {

                    const ancienneExpiration =
                        new Date(
                            utilisateursPremium[0].abonnement_expiration
                        );

                    if (
                        !Number.isNaN(
                            ancienneExpiration.getTime()
                        ) &&
                        ancienneExpiration.getTime() > Date.now()
                    ) {
                        baseExpiration = ancienneExpiration;
                    }
                }

                baseExpiration.setMonth(
                    baseExpiration.getMonth() + 1
                );

                const nouvelleExpiration =
                    baseExpiration.toISOString();

                await sqlite(`
                    UPDATE utilisateurs
                    SET
                        abonnement_actif = 1,
                        abonnement_expiration = '${nouvelleExpiration}',
                        type_compte = 'illimite'
                    WHERE email = '${email.replace(/'/g, "''")}'
                `);

                console.log(
                    "✅ Nouvelle expiration Premium :",
                    nouvelleExpiration
                );

                console.log(
                    "✅ Paiement Premium enregistré et abonnement activé :",
                    transactionId,
                    email
                );
            }

            sendJSON(res, 200, { received: true });

        } catch (error) {

            console.error("Webhook Fedapay invalide :", error.message);

            sendJSON(res, 400, {
                success: false,
                message: "Signature invalide."
            });

        }

        return;
    }

    if (req.url === "/" ||
        req.url === "/index.html") {

        const file =
            path.join(__dirname, "index.html");

        fs.readFile(file, (error, data) => {

            if (error) {

                sendJSON(res, 500, {
                    success: false,
                    message: "Impossible de charger NEXORA."
                });

                return;
            }

            res.writeHead(200, {
                "Content-Type":
                    "text/html; charset=utf-8"
            });

            res.end(data);
        });

        return;
    }

    sendJSON(res, 404, {
        success: false,
        message: "Route introuvable."
    });
}

async function start() {

    await initDB();
    await initialiserTablePaiementsPremium();

    const server =
        http.createServer((req, res) => {

            handleRequest(req, res)
                .catch(error => {

                    console.error(error);

                    sendJSON(res, 500, {
                        success: false,
                        message: "Erreur serveur."
                    });

                });

        });

    server.listen(PORT, HOST, () => {

        console.log(
            `NEXORA démarré sur http://localhost:${PORT}`
        );

    });
}

start().catch(error => {

    console.error(
        "Impossible de démarrer NEXORA :",
        error
    );

});
