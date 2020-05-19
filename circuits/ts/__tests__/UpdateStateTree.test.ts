import {
    compileAndLoadCircuit,
} from '../'

import { MaciState } from 'maci-core'

import {
    Keypair,
    Command,
} from 'maci-domainobjs'
import {
    genRandomSalt,
    bigInt,
} from 'maci-crypto'

import { config } from 'maci-config'

const stateTreeDepth = config.maci.merkleTrees.stateTreeDepth
const messageTreeDepth = config.maci.merkleTrees.messageTreeDepth
const voteOptionTreeDepth = config.maci.merkleTrees.voteOptionTreeDepth
const initialVoiceCreditBalance = config.maci.initialVoiceCreditBalance
const voteOptionsMaxIndex = config.maci.voteOptionsMaxLeafIndex

// Set up keypairs
const user = new Keypair()
const coordinator = new Keypair()

const stateIndex = bigInt(1)
const voteOptionIndex = bigInt(0)
const newVoteWeight = bigInt(9)
const nonce = bigInt(1)
const salt = genRandomSalt()

const command = new Command(
    stateIndex,
    user.pubKey,
    voteOptionIndex,
    newVoteWeight,
    nonce,
    salt,
)

const signature = command.sign(user.privKey)
const sharedKey = Keypair.genEcdhSharedKey(user.privKey, coordinator.pubKey)
const message = command.encrypt(signature, sharedKey)

describe('State tree root update verification circuit', () => {
    let circuit 
    let circuitChecks
    let circuitInputs

    const maciState = new MaciState(
        coordinator,
        stateTreeDepth,
        messageTreeDepth,
        voteOptionTreeDepth,
        voteOptionsMaxIndex,
    )

    beforeAll(async () => {
        circuit = await compileAndLoadCircuit('test/updateStateTree_test.circom')
        circuitChecks = await compileAndLoadCircuit('test/performChecksBeforeUpdate_test.circom')

        // Sign up the user
        maciState.signUp(user.pubKey, initialVoiceCreditBalance)

        // Publish a message
        maciState.publishMessage(message, user.pubKey)
    })

    it('UpdateStateTree should produce the correct state root', async () => {
        // Generate circuit inputs
        circuitInputs = maciState.genUpdateStateTreeCircuitInputs(0)

        // Calculate the witness
        const witness = circuit.calculateWitness(circuitInputs)
        expect(circuit.checkWitness(witness)).toBeTruthy()

        // Get the circuit-generated root
        const idx = circuit.getSignalIdx('main.root')
        const circuitNewStateRoot = witness[idx].toString()

        const stateRootBefore = maciState.genStateRoot()

        // Before we run process the message via maciState.processMessage(),
        // the root generated by the circuit should not match
        expect(circuitNewStateRoot.toString()).not.toEqual(stateRootBefore.toString())

        // Process the message
        maciState.processMessage(0)
        const stateRootAfter = maciState.genStateRoot()

        expect(stateRootBefore.toString()).not.toEqual(stateRootAfter)

        // After we run process the message via maciState.processMessage(),
        // the root generated by the circuit should match
        expect(circuitNewStateRoot.toString()).toEqual(stateRootAfter.toString())
    })

    //it('PerformChecksBeforeUpdate should confirm signature is valid on valid inputs', async () => {
        //// Calculate the witness
        //const witness = circuitChecks.calculateWitness(circuitInputs)
        //expect(circuitChecks.checkWitness(witness)).toBeTruthy()
    //})

})
