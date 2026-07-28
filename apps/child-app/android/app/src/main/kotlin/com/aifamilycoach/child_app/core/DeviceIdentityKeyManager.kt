package com.aifamilycoach.child_app.core

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.spec.ECGenParameterSpec

/**
 * Sprint 3's "Kotlin native bridge preparation." Implements the Device
 * Identity mechanism from
 * docs/architecture/pairing-state-machine.md §1: an asymmetric keypair
 * generated INSIDE Android Keystore (hardware-backed via TEE/StrongBox
 * where the device supports it) — never a CA-issued certificate, never
 * an exportable private key. This is the ONLY thing this class does;
 * Key Attestation chain retrieval (proving the key is hardware-backed to
 * the backend) is a separate, not-yet-built piece — see the class-level
 * NOTE below.
 */
object DeviceIdentityKeyManager {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "afdc_device_identity_key"

    /**
     * Idempotent — safe to call on every app start. Does nothing if the
     * key already exists (Android Keystore keys survive app restarts;
     * they do NOT survive an app uninstall/reinstall or a factory
     * reset — a new keypair is generated in that case, which is exactly
     * the "did this device change" signal
     * schema-change-proposal-pairing.md CR-5's fingerprint concept relies on).
     */
    fun ensureKeyPairExists() {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
        keyStore.load(null)
        if (keyStore.containsAlias(KEY_ALIAS)) return

        val generator = KeyPairGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_EC,
            ANDROID_KEYSTORE,
        )
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
        )
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .build()
        generator.initialize(spec)
        generator.generateKeyPair()
    }

    /**
     * Returns the public key as Base64-encoded X.509 SubjectPublicKeyInfo
     * — the exact string shape the backend's `POST /pairing/device/register`
     * expects for its `publicKey` field
     * (pairing-backend-domain-architecture.md §3). The private key never
     * leaves this method — it is never read, exported, or serialized
     * anywhere; only the public half crosses the platform channel.
     */
    fun getPublicKeyBase64(): String {
        ensureKeyPairExists()
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
        keyStore.load(null)
        val certificate = keyStore.getCertificate(KEY_ALIAS)
        return Base64.encodeToString(certificate.publicKey.encoded, Base64.NO_WRAP)
    }

    // NOTE (honest limitation, matches the same disclosure in
    // pairing-sprint3-backend-vertical.md §4): Key Attestation chain
    // retrieval (proving to the backend this key is genuinely
    // hardware-backed, not software-emulated) is NOT implemented here.
    // That requires requesting an attestation certificate chain at key
    // generation time (`setAttestationChallenge` on the KeyGenParameterSpec
    // builder) and exposing it via a second platform-channel method —
    // deferred to a focused follow-up, not silently assumed done.
}
