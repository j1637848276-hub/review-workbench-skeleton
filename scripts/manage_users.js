'use strict'

/**
 * User administration from the shell. The way to create the first admin
 * without putting a password in `.env`.
 *
 *   node --env-file=.env scripts/manage_users.js list
 *   node --env-file=.env scripts/manage_users.js create <username> <role>
 *   node --env-file=.env scripts/manage_users.js passwd <username>
 *   node --env-file=.env scripts/manage_users.js role   <username> <role>
 *   node --env-file=.env scripts/manage_users.js disable <username>
 *   node --env-file=.env scripts/manage_users.js enable  <username>
 *
 * Passwords are prompted with echo off, never taken from argv. A password in
 * an argument lands in your shell history and in the process list, where every
 * other user on the box can read it.
 */

const path = require('node:path')
const readline = require('node:readline')

const { loadConfig } = require('../lib/config')
const { openDatabase } = require('../lib/storage/database')
const { createUserRepository } = require('../repositories/user_repository')
const { createAuthService } = require('../services/auth_service')
const { MIN_PASSWORD_LENGTH } = require('../lib/auth/password')

const ROLES = ['admin', 'reviewer', 'viewer']

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    })
    const stdin = process.stdin
    const wasRaw = stdin.isRaw

    process.stdout.write(question)

    // Echo suppression. `readline` has no built-in for this, so intercept the
    // output stream that would print the keystrokes.
    const onData = () => {}
    if (stdin.isTTY) stdin.setRawMode?.(false)
    rl.output.write = (chunk, encoding, callback) => {
      if (typeof chunk === 'string' && chunk.includes(question)) {
        process.stdout.write(chunk, encoding, callback)
      } else if (typeof callback === 'function') {
        callback()
      }
      return true
    }

    rl.question('', (answer) => {
      rl.close()
      stdin.removeListener('data', onData)
      if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode?.(wasRaw)
      process.stdout.write('\n')
      resolve(answer)
    })
    rl.on('error', reject)
  })
}

async function readNewPassword() {
  const first = await promptHidden(`New password (min ${MIN_PASSWORD_LENGTH} chars): `)
  const second = await promptHidden('Repeat: ')
  if (first !== second) throw new Error('Passwords do not match.')
  return first
}

function requireUser(userRepository, username) {
  const user = userRepository.findByUsername(username)
  if (!user) throw new Error(`No such user: ${username}`)
  return user
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const config = loadConfig({ projectRoot: path.join(__dirname, '..') })
  const db = openDatabase({ dbPath: config.storage.databasePath })
  const userRepository = createUserRepository({ db })
  const authService = createAuthService({ userRepository, config })

  try {
    switch (command) {
      case 'list': {
        const users = userRepository.list()
        if (users.length === 0) {
          process.stdout.write('No users yet. Create one:\n  npm run users -- create admin admin\n')
          break
        }
        for (const user of users) {
          process.stdout.write(
            `${String(user.id).padStart(4)}  ${user.username.padEnd(20)} ${user.role.padEnd(9)} ` +
              `${user.isActive ? 'active  ' : 'disabled'} last login ${user.lastLoginAt ?? 'never'}\n`
          )
        }
        break
      }

      case 'create': {
        const [username, role] = args
        if (!username || !ROLES.includes(role)) {
          throw new Error(`Usage: create <username> <${ROLES.join('|')}>`)
        }
        const password = await readNewPassword()
        const user = await authService.createUser({ username, password, role })
        process.stdout.write(`Created ${user.username} (${user.role}).\n`)
        break
      }

      case 'passwd': {
        const [username] = args
        const user = requireUser(userRepository, username)
        const password = await readNewPassword()
        await authService.changePassword({
          userId: user.id,
          newPassword: password,
          requireCurrent: false,
        })
        process.stdout.write(`Password updated for ${user.username}.\n`)
        break
      }

      case 'role': {
        const [username, role] = args
        if (!ROLES.includes(role)) throw new Error(`role must be one of: ${ROLES.join(', ')}`)
        const user = requireUser(userRepository, username)
        userRepository.setRole(user.id, role)
        process.stdout.write(`${user.username} is now ${role}.\n`)
        break
      }

      case 'disable':
      case 'enable': {
        const [username] = args
        const user = requireUser(userRepository, username)
        userRepository.setActive(user.id, command === 'enable')
        process.stdout.write(`${user.username} ${command === 'enable' ? 'enabled' : 'disabled'}.\n`)
        break
      }

      default:
        process.stdout.write(
          'Usage:\n' +
            '  list\n' +
            `  create <username> <${ROLES.join('|')}>\n` +
            '  passwd <username>\n' +
            `  role <username> <${ROLES.join('|')}>\n` +
            '  disable <username>\n' +
            '  enable <username>\n'
        )
        process.exitCode = command ? 1 : 0
    }
  } finally {
    db.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
