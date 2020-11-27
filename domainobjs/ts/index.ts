import * as assert from 'assert'
import base64url from "base64url"
import {
    Ciphertext,
    EcdhSharedKey,
    Signature,
    PubKey as RawPubKey,
    PrivKey as RawPrivKey,
    G1Point,
    G2Point,
    encrypt,
    decrypt,
    sign,
    hash3,
    hash4,
    hash5,
    verifySignature,
    genRandomSalt,
    genKeypair,
    genPubKey,
    formatPrivKeyForBabyJub,
    genEcdhSharedKey,
    packPubKey,
    unpackPubKey,
    SNARK_FIELD_SIZE
} from 'maci-crypto'

const SERIALIZED_PRIV_KEY_PREFIX = 'macisk.'

class VerifyingKey {
    public alpha1: G1Point
    public beta2: G2Point
    public gamma2: G2Point
    public delta2: G2Point
    public ic: G1Point[]

    constructor (
        _alpha1: G1Point,
        _beta2: G2Point,
        _gamma2: G2Point,
        _delta2: G2Point,
        _ic: G1Point[],
    ) {
        this.alpha1 = _alpha1
        this.beta2 = _beta2
        this.gamma2 = _gamma2
        this.delta2 = _delta2
        this.ic = _ic
    }

    public asContractParam() {
        return {
            alpha1: this.alpha1.asContractParam(),
            beta2: this.beta2.asContractParam(),
            gamma2: this.gamma2.asContractParam(),
            delta2: this.delta2.asContractParam(),
            ic: this.ic.map((x) => x.asContractParam()),
        }
    }

    public static fromContract(data: any): VerifyingKey {
        const convertG2 = (point: any): G2Point => {
            return new G2Point(
                [
                    BigInt(point.x[0]),
                    BigInt(point.x[1]),
                ],
                [
                    BigInt(point.y[0]),
                    BigInt(point.y[1]),
                ],
            )
        }

        return new VerifyingKey(
            new G1Point( 
                BigInt(data.alpha1.x),
                BigInt(data.alpha1.y),
            ),
            convertG2(data.beta2),
            convertG2(data.gamma2),
            convertG2(data.delta2),
            data.ic.map(
                (c: any) => new G1Point(BigInt(c.x), BigInt(c.y))
            ),
        )
    }

    public equals(vk: VerifyingKey): boolean {
        let icEqual = this.ic.length === vk.ic.length

        // Immediately return false if the length doesn't match
        if (!icEqual) {
            return false
        }

        // Each element in ic must match
        for (let i = 0; i < this.ic.length; i ++) {
            icEqual = icEqual && this.ic[i].equals(vk.ic[i])
        }

        return this.alpha1.equals(vk.alpha1) && 
            this.beta2.equals(vk.beta2) && 
            this.gamma2.equals(vk.gamma2) && 
            this.delta2.equals(vk.delta2) && 
            icEqual
    }
}

interface Proof {
    a: G1Point;
    b: G2Point;
    c: G1Point;
}

class PrivKey {
    public rawPrivKey: RawPrivKey

    constructor (rawPrivKey: RawPrivKey) {
        this.rawPrivKey = rawPrivKey
    }

    public copy = (): PrivKey => {
        return new PrivKey(BigInt(this.rawPrivKey.toString()))
    }

    public asCircuitInputs = () => {
        return formatPrivKeyForBabyJub(this.rawPrivKey).toString()
    }

    public serialize = (): string => {
        return SERIALIZED_PRIV_KEY_PREFIX + this.rawPrivKey.toString(16)
    }

    public static unserialize = (s: string): PrivKey => {
        const x = s.slice(SERIALIZED_PRIV_KEY_PREFIX.length)
        return new PrivKey(BigInt('0x' + x))
    }

    public static isValidSerializedPrivKey = (s: string): boolean => {
        const correctPrefix = s.startsWith(SERIALIZED_PRIV_KEY_PREFIX)
        const x = s.slice(SERIALIZED_PRIV_KEY_PREFIX.length)

        let validValue = false
        try {
            const value = BigInt('0x' + x)
            validValue = value < SNARK_FIELD_SIZE
        } catch {
            // comment to make linter happy 
        }

        return correctPrefix && validValue
    }
}

const SERIALIZED_PUB_KEY_PREFIX = 'macipk.'

class PubKey {
    public rawPubKey: RawPubKey

    constructor (rawPubKey: RawPubKey) {
        assert(rawPubKey.length === 2)
        assert(rawPubKey[0] < SNARK_FIELD_SIZE)
        assert(rawPubKey[1] < SNARK_FIELD_SIZE)
        this.rawPubKey = rawPubKey
    }

    public copy = (): PubKey => {

        return new PubKey([
            BigInt(this.rawPubKey[0].toString()),
            BigInt(this.rawPubKey[1].toString()),
        ])
    }

    public asContractParam = () => {
        return { 
            x: this.rawPubKey[0].toString(),
            y: this.rawPubKey[1].toString(),
        }
    }

    public asCircuitInputs = () => {
        return this.rawPubKey.map((x) => x.toString())
    }

    public asArray = (): BigInt[] => {
        return [
            this.rawPubKey[0],
            this.rawPubKey[1],
        ]
    }

    public serialize = (): string => {
        // Blank leaves have pubkey [0, 0], which packPubKey does not support
        if (
            BigInt(this.rawPubKey[0]) === BigInt(0) && 
            BigInt(this.rawPubKey[1]) === BigInt(0)
        ) {
            return SERIALIZED_PUB_KEY_PREFIX + 'z'
        }
        const packed = packPubKey(this.rawPubKey).toString('hex')
        return SERIALIZED_PUB_KEY_PREFIX + packed.toString()
    }

    public static unserialize = (s: string): PubKey => {
        // Blank leaves have pubkey [0, 0], which packPubKey does not support
        if (s === SERIALIZED_PUB_KEY_PREFIX + 'z') {
            return new PubKey([BigInt(0), BigInt(0)])
        }

        const len = SERIALIZED_PUB_KEY_PREFIX.length
        const packed = Buffer.from(s.slice(len), 'hex')
        return new PubKey(unpackPubKey(packed))
    }

    public static isValidSerializedPubKey = (s: string): boolean => {
        const correctPrefix = s.startsWith(SERIALIZED_PUB_KEY_PREFIX)

        let validValue = false
        try {
            PubKey.unserialize(s)
            validValue = true
        } catch {
            // comment to make linter happy
        }

        return correctPrefix && validValue
    }
}

class Keypair {
    public privKey: PrivKey
    public pubKey: PubKey

    constructor (
        privKey?: PrivKey,
    ) {
        if (privKey) {
            this.privKey = privKey
            this.pubKey = new PubKey(genPubKey(privKey.rawPrivKey))
        } else {
            const rawKeyPair = genKeypair()
            this.privKey = new PrivKey(rawKeyPair.privKey)
            this.pubKey = new PubKey(rawKeyPair.pubKey)
        }
    }

    public copy = (): Keypair => {
        return new Keypair(this.privKey.copy())
    }
    
    public static genEcdhSharedKey(
        privKey: PrivKey,
        pubKey: PubKey,
    ) {
        return genEcdhSharedKey(privKey.rawPrivKey, pubKey.rawPubKey)
    }

    public equals(
        keypair: Keypair,
    ): boolean {

        const equalPrivKey = this.privKey.rawPrivKey === keypair.privKey.rawPrivKey
        const equalPubKey =
            this.pubKey.rawPubKey[0] === keypair.pubKey.rawPubKey[0] &&
            this.pubKey.rawPubKey[1] === keypair.pubKey.rawPubKey[1]

        // If this assertion fails, something is very wrong and this function
        // should not return anything 
        // XOR is equivalent to: (x && !y) || (!x && y ) 
        const x = (equalPrivKey && equalPubKey) 
        const y = (!equalPrivKey && !equalPubKey) 

        assert((x && !y) || (!x && y))

        return equalPrivKey
    }
}


interface IStateLeaf {
    pubKey: PubKey;
    voiceCreditBalance: BigInt;
}

interface VoteOptionTreeLeaf {
    votes: BigInt;
}

/*
 * An encrypted command and signature.
 */
class Message {
    public iv: BigInt
    public data: BigInt[]
    public static DATA_LENGTH = 7

    constructor (
        iv: BigInt,
        data: BigInt[],
    ) {
        assert(data.length === Message.DATA_LENGTH)
        this.iv = iv
        this.data = data
    }

    private asArray = (): BigInt[] => {

        return [
            this.iv,
            ...this.data,
        ]
    }

    public asContractParam = () => {
        return {
            iv: this.iv.toString(),
            data: this.data.map((x: BigInt) => x.toString()),
        }
    }

    public asCircuitInputs = (): BigInt[] => {

        return this.asArray()
    }

    public hash = (): BigInt => {
        const p = this.data
        return hash4([
            hash5([this.iv, p[0], p[1], p[2], p[3]]),
            p[4],
            p[5],
            p[6],
        ])
    }

    public copy = (): Message => {

        return new Message(
            BigInt(this.iv.toString()),
            this.data.map((x: BigInt) => BigInt(x.toString())),
        )
    }
}

/*
 * A leaf in the state tree, which maps public keys to voice credit balances
 */
class StateLeaf implements IStateLeaf {
    public pubKey: PubKey
    public voiceCreditBalance: BigInt

    constructor (
        pubKey: PubKey,
        voiceCreditBalance: BigInt,
    ) {
        this.pubKey = pubKey
        this.voiceCreditBalance = voiceCreditBalance
    }

    /*
     * Deep-copies the object
     */
    public copy(): StateLeaf {
        return new StateLeaf(
            this.pubKey.copy(),
            BigInt(this.voiceCreditBalance.toString()),
        )
    }

    public static genBlankLeaf(): StateLeaf {
        return new StateLeaf(
            new PubKey([BigInt(0), BigInt(0)]),
            BigInt(0),
        )
    }

    public static genRandomLeaf() {
        const keypair = new Keypair()
        return new StateLeaf(
            keypair.pubKey,
            genRandomSalt(),
        )
    }

    private asArray = (): BigInt[] => {

        return [
            ...this.pubKey.asArray(),
            this.voiceCreditBalance,
        ]
    }

    public asCircuitInputs = (): BigInt[] => {

        return this.asArray()
    }

    public hash = (): BigInt => {

        return hash3(this.asArray())
    }

    public asContractParam() {
        return {
            pubKey: this.pubKey.asContractParam(),
            voiceCreditBalance: this.voiceCreditBalance.toString(),
        }
    }

    public serialize = (): string => {
        const j = {
            pubKey: this.pubKey.serialize(),
            voiceCreditBalance: this.voiceCreditBalance.toString(16),
        }


        return base64url(
            Buffer.from(JSON.stringify(j, null, 0), 'utf8')
        )
    }

    static unserialize = (serialized: string): StateLeaf => {
        const j = JSON.parse(base64url.decode(serialized))

        return new StateLeaf(
            PubKey.unserialize(j.pubKey),
            BigInt('0x' + j.voiceCreditBalance),
        )
    }
}

interface ICommand {
    stateIndex: BigInt;
    newPubKey: PubKey;
    voteOptionIndex: BigInt;
    newVoteWeight: BigInt;
    nonce: BigInt;

    sign: (PrivKey) => Signature;
    encrypt: (EcdhSharedKey, Signature) => Message;
}

/*
 * Unencrypted data whose fields include the user's public key, vote etc.
 */
class Command implements ICommand {
    public stateIndex: BigInt
    public newPubKey: PubKey
    public voteOptionIndex: BigInt
    public newVoteWeight: BigInt
    public nonce: BigInt
    public pollId: BigInt
    public salt: BigInt

    constructor (
        stateIndex: BigInt,
        newPubKey: PubKey,
        voteOptionIndex: BigInt,
        newVoteWeight: BigInt,
        nonce: BigInt,
        pollId: BigInt,
        salt: BigInt = genRandomSalt(),
    ) {
        const limit50Bits = BigInt(2 ** 50)
        assert(limit50Bits >= stateIndex)
        assert(limit50Bits >= voteOptionIndex)
        assert(limit50Bits >= newVoteWeight)
        assert(limit50Bits >= nonce)
        assert(limit50Bits >= pollId)

        this.stateIndex = stateIndex
        this.newPubKey = newPubKey
        this.voteOptionIndex = voteOptionIndex
        this.newVoteWeight = newVoteWeight
        this.nonce = nonce
        this.pollId = pollId
        this.salt = salt
    }

    public copy = (): Command => {

        return new Command(
            BigInt(this.stateIndex.toString()),
            this.newPubKey.copy(),
            BigInt(this.voteOptionIndex.toString()),
            BigInt(this.newVoteWeight.toString()),
            BigInt(this.nonce.toString()),
            BigInt(this.pollId.toString()),
            BigInt(this.salt.toString()),
        )
    }

    public asArray = (): BigInt[] => {
        const p =
            BigInt(this.stateIndex) +
            (BigInt(this.voteOptionIndex) << BigInt(50)) +
            (BigInt(this.newVoteWeight) << BigInt(100)) +
            (BigInt(this.nonce) << BigInt(150)) +
            (BigInt(this.pollId) << BigInt(200))

        const a = [
            p,
            ...this.newPubKey.asArray(),
            this.salt,
        ]
        assert(a.length === 4)
        return a
    }

    /*
     * Check whether this command has deep equivalence to another command
     */
    public equals = (command: Command): boolean => {

        return this.stateIndex == command.stateIndex &&
            this.newPubKey[0] == command.newPubKey[0] &&
            this.newPubKey[1] == command.newPubKey[1] &&
            this.voteOptionIndex == command.voteOptionIndex &&
            this.newVoteWeight == command.newVoteWeight &&
            this.nonce == command.nonce &&
            this.pollId == command.pollId &&
            this.salt == command.salt
    }

    public hash = (): BigInt => {
        return hash4(this.asArray())
    }

    /*
     * Signs this command and returns a Signature.
     */
    public sign = (
        privKey: PrivKey,
    ): Signature => {

        return sign(privKey.rawPrivKey, this.hash())
    }

    /*
     * Returns true if the given signature is a correct signature of this
     * command and signed by the private key associated with the given public
     * key.
     */
    public verifySignature = (
        signature: Signature,
        pubKey: PubKey,
    ): boolean => {

        return verifySignature(
            this.hash(),
            signature,
            pubKey.rawPubKey,
        )
    }

    /*
     * Encrypts this command along with a signature to produce a Message.
     * To save gas, we can constrain the following values to 50 bits and pack
     * them into a 250-bit value:
     * 0. state index
     * 3. vote option index
     * 4. new vote weight
     * 5. nonce
     * 6. poll ID
     */
    public encrypt = (
        signature: Signature,
        sharedKey: EcdhSharedKey,
    ): Message => {
        const plaintext = [
            ...this.asArray(),
            signature.R8[0],
            signature.R8[1],
            signature.S,
        ]

        assert(plaintext.length === 7)

        const ciphertext: Ciphertext = encrypt(plaintext, sharedKey)
        assert(ciphertext.data.length === plaintext.length)

        const message = new Message(ciphertext.iv, ciphertext.data)
        
        return message
    }

    /*
     * Decrypts a Message to produce a Command.
     */
    public static decrypt = (
        message: Message,
        sharedKey: EcdhSharedKey,
    ) => {

        const decrypted = decrypt(message, sharedKey)

        const p = BigInt(decrypted[0])

        // Returns the value of the 50 bits at position `pos` in `val`
        // create 50 '1' bits
        // shift left by pos
        // AND with val
        // shift right by pos
        const extract = (val: BigInt, pos: number): BigInt => {
            return BigInt(
                (
                    (
                        (BigInt(1) << BigInt(50)) - BigInt(1)
                    ) << BigInt(pos)
                ) & BigInt(val)
            ) >> BigInt(pos)
        }

        // p is a packed value
        // bits 0 - 50:    stateIndex
        // bits 51 - 100:  voteOptionIndex
        // bits 101 - 150: newVoteWeight
        // bits 151 - 200: nonce
        // bits 201 - 250: pollId
        const stateIndex = extract(p, 0)
        const voteOptionIndex = extract(p, 50)
        const newVoteWeight = extract(p, 100)
        const nonce = extract(p, 150)
        const pollId = extract(p, 200)

        const newPubKey = new PubKey([decrypted[1], decrypted[2]])
        const salt = decrypted[3]

        const command = new Command(
            stateIndex,
            newPubKey,
            voteOptionIndex,
            newVoteWeight,
            nonce,
            pollId,
            salt,
        )

        const signature = {
            R8: [decrypted[4], decrypted[5]],
            S: decrypted[6],
        }

        return { command, signature }
    }
}

export {
    StateLeaf,
    VoteOptionTreeLeaf,
    Command,
    Message,
    Keypair,
    PubKey,
    PrivKey,
    VerifyingKey,
    Proof,
}
