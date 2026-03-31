# dotenvrtdb

A simple dotenv CLI for loading environment variables from `.env` files **with remote realtime database support**.

[![npm version](https://img.shields.io/npm/v/@tolaptrinhdh61-spec/dotenvrtdb.svg)](https://www.npmjs.com/package/@tolaptrinhdh61-spec/dotenvrtdb)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

✨ All standard dotenv-cli features  
🔥 **Pull** environment variables from remote databases (Firebase, custom APIs)  
🚀 **Push** local .env files to remote databases  
🔒 Automatic auth token masking in console output  
📦 Support for multiple file formats and cascading environments  
🌐 Works with HTTP/HTTPS endpoints

## Installing

### NPM

```bash
$ npm install -g @tolaptrinhdh61-spec/dotenvrtdb
```

### Yarn

```bash
$ yarn global add @tolaptrinhdh61-spec/dotenvrtdb
```

### pnpm

```bash
$ pnpm add -g @tolaptrinhdh61-spec/dotenvrtdb
```

### GitHub Packages

To install from GitHub Packages, create a `.npmrc` file:

```
@tolaptrinhdh61-spec:registry=https://npm.pkg.github.com
```

Then install:

```bash
$ npm install -g @tolaptrinhdh61-spec/dotenvrtdb
```

## Usage

### Basic Usage

```bash
$ dotenvrtdb -- <command with arguments>
```

This will load the variables from the .env file in the current working directory and then run the command (using the new set of environment variables).

Alternatively, if you do not need to pass arguments to the command, you can use the shorthand:

```bash
$ dotenvrtdb <command>
```

### 🔥 Remote Database Sync

#### Pull environment variables from remote database

Download environment variables from a realtime database (Firebase, custom API, etc.) and save to a local `.env` file:

```bash
# Pull to default .env file
$ dotenvrtdb --pull --eUrl=https://your-project.firebaseio.com/env.json -e .env

# Pull to custom file using -e flag
$ dotenvrtdb --pull --eUrl=https://your-project.firebaseio.com/env.json -e .env.production

# Or specify -e flag before --pull
$ dotenvrtdb -e .env.staging --pull --eUrl=https://your-project.firebaseio.com/env.json
```

#### Push environment variables to remote database

Upload your local `.env` file to a realtime database:

```bash
# Push from default .env file
$ dotenvrtdb --push --eUrl=https://your-project.firebaseio.com/env.json -e .env

# Push from custom file using -e flag
$ dotenvrtdb --push --eUrl=https://your-project.firebaseio.com/env.json -e .env.production

# Or specify -e flag before --push
$ dotenvrtdb -e .env.staging --push --eUrl=https://your-project.firebaseio.com/env.json
```

#### Example workflow:

```bash
# Pull production env from Firebase
$ dotenvrtdb --pull --eUrl=https://myapp.firebaseio.com/env/prod.json -e .env.production

# Run your app with production env
$ dotenvrtdb -e .env.production -- node app.js

# Update local env and push back
$ dotenvrtdb --push --eUrl=https://myapp.firebaseio.com/env/prod.json -e .env.production
```

#### Resolve file directives inside `.env`

Format directive:

```env
SERVICE_ACCOUNT_JSON=file:raw:./secrets/service-account.json
SSL_CERT_B64=file:base64:./secrets/tls.crt
```

- `file:raw:<path>`: đọc file UTF-8 và đưa trực tiếp vào biến.
- `file:base64:<path>`: đọc file binary và encode base64 vào biến.
- Path tương đối được resolve từ thư mục chứa file `-e`.

Chạy độc lập:

```bash
$ dotenvrtdb -e .env --resolvefilevars
```

Khi chạy `--pull`, luồng resolve này cũng được chạy trước khi ghi file `.env`.

### Custom .env files

Another .env file could be specified using the -e flag (this will replace loading `.env` file):

```bash
$ dotenvrtdb -e .env2 -- <command with arguments>
```

Multiple .env files can be specified, and will be processed in order, but only sets variables if they haven't already been set. So the first one wins (existing env variables win over the first file and the first file wins over the second file):

```bash
$ dotenvrtdb -e .env3 -e .env4 -- <command with arguments>
```

### Cascading env variables

Some applications load env variables from multiple `.env` files depending on the environment:

- `.env`
- `.env.local`
- `.env.development`
- `.env.development.local`

dotenvrtdb supports this using the `-c` flag:

- `-c` loads `.env` and `.env.local`
- `-c test` loads `.env`, `.env.local`, `.env.test`, and `.env.test.local`

The `-c` flag can be used together with the `-e` flag. The following example will cascade env files located one folder up in the directory tree (`../.env` followed by `../.env.local`):

```bash
dotenvrtdb -e ../.env -c
```

### Setting variable from command line

It is possible to set variable directly from command line using the -v flag:

```bash
$ dotenvrtdb -v VARIABLE=somevalue -- <command with arguments>
```

Multiple variables can be specified:

```bash
$ dotenvrtdb -v VARIABLE1=somevalue1 -v VARIABLE2=somevalue2 -- <command with arguments>
```

Variables set up from command line have higher priority than from env files.

> Purpose of this is that standard approach `VARIABLE=somevalue <command with arguments>` doesn't work on Windows. The -v flag works on all the platforms.

### Check env variable

If you want to check the value of an environment variable, use the `-p` flag

```bash
$ dotenvrtdb -p NODE_ENV
```

### Flags to the underlying command

If you want to pass flags to the inner command use `--` after all the flags to `dotenvrtdb`.

E.g. the following command without dotenvrtdb:

```bash
mvn exec:java -Dexec.args="-g -f"
```

will become the following command with dotenvrtdb:

```bash
$ dotenvrtdb -- mvn exec:java -Dexec.args="-g -f"
```

or in case the env file is at `.my-env`

```bash
$ dotenvrtdb -e .my-env -- mvn exec:java -Dexec.args="-g -f"
```

### Variable expansion

We support expanding env variables inside .env files (See [dotenv-expand](https://github.com/motdotla/dotenv-expand) npm package for more information)

For example:

```
IP=127.0.0.1
PORT=1234
APP_URL=http://${IP}:${PORT}
```

Using the above example `.env` file, `process.env.APP_URL` would be `http://127.0.0.1:1234`.

#### Disabling variable expansion

If your `.env` variables include values that should not be expanded (e.g. `PASSWORD="pas$word"`), you can pass flag `--no-expand` to `dotenvrtdb` to disable variable expansion.

For example:

```bash
dotenvrtdb --no-expand <command>
```

### Variable expansion in the command

If your `.env` file looks like:

```
SAY_HI=hello!
```

you might expect `dotenvrtdb echo "$SAY_HI"` to display `hello!`. In fact, this is not what happens: your shell will first interpret your command before passing it to `dotenvrtdb`, so if `SAY_HI` envvar is set to `""`, the command will be expanded into `dotenvrtdb echo`: that's why `dotenvrtdb` cannot make the expansion you expect.

#### Possible solutions

1. Use `--shell` (cross-env-shell style)

Run the underlying command through a shell so operators (`&&`, `|`, redirection, env expansion) work in the *child* process after env is loaded.

```bash
# Windows (cmd.exe): use %VAR% for env expansion
dotenvrtdb -e .env --shell -- "echo %SAY_HI%"

# bash/sh: use $VAR
dotenvrtdb -e .env --shell -- 'echo "$SAY_HI"'

# inline env (optional)
dotenvrtdb --shell -- FOO=bar "echo %FOO%"
```

2. Bash and escape

One possible way to get the desired result is:

```bash
$ dotenvrtdb -- bash -c 'echo "$SAY_HI"'
```

In bash, everything between `'` is not interpreted but passed as is. Since `$SAY_HI` is inside `''` brackets, it's passed as a string literal.

Therefore, `dotenvrtdb` will start a child process `bash -c 'echo "$SAY_HI"'` with the env variable `SAY_HI` set correctly which means bash will run `echo "$SAY_HI"` in the right environment which will print correctly `hello`

3. Subscript encapsulation

Another solution is simply to encapsulate your script in another subscript.

Example here with npm scripts in a package.json

```json
{
  "scripts": {
    "_print-stuff": "echo $STUFF",
    "print-stuff": "dotenvrtdb -- npm run _print-stuff"
  }
}
```

This example is used in a project setting (has a package.json). Should always install locally `npm install -D @tolaptrinhdh61-spec/dotenvrtdb`

### Debugging

You can add the `--debug` flag to output the `.env` files that would be processed and exit.

### Override

Override any environment variables that have already been set on your machine with values from your .env file.

```bash
dotenvrtdb -e .env.test -o -- jest
```

## Command Reference

```
Usage: dotenvrtdb [--help] [--debug] [--quiet=false] [-e <path>] [-v <n>=<value>]
                  [-p <variable name>] [-c [environment]] [--no-expand] [--shell[=<shell>]] [-- command]

Options:
  --help              print help
  --debug             output the files that would be processed but don't actually parse them
  --quiet, -q         suppress debug output from dotenv (default: true)
  -e <path>           parses the file <path> as a `.env` file
  -e <path>           multiple -e flags are allowed
  -v <n>=<value>      put variable <n> into environment using value <value>
  -v <n>=<value>      multiple -v flags are allowed
  -p <variable>       print value of <variable> to the console
  -c [environment]    support cascading env variables from multiple files
  --no-expand         skip variable expansion
  --shell[=<shell>]   run the `command` through a shell (cross-env-shell style)
  -o, --override      override system variables. Cannot be used with cascade (-c)
  command             command to run with environment variables loaded

Remote database commands:
  --eUrl=<url>        remote URL for pull/push
  --pull              pull env variables from --eUrl and save to file
                      use with -e flag to specify output file (default: .env)
                      example: dotenvrtdb --pull --eUrl=<url> -e .env.production
  --push              push local .env file to --eUrl
                      use with -e flag to specify source file (default: .env)
                      example: dotenvrtdb --push --eUrl=<url> -e .env.staging
  --resolvefilevars   resolve directives file:<raw|base64>:<path> in file -e
```

## Use Cases

### Team Environment Sync

Keep your team's environment variables in sync using Firebase Realtime Database:

```bash
# Team lead pushes the base config
$ dotenvrtdb --push --eUrl=https://team-project.firebaseio.com/env/base.json

# Team members pull the config
$ dotenvrtdb --pull --eUrl=https://team-project.firebaseio.com/env/base.json
```

### Multi-Environment Deployment

Manage different environments easily:

```bash
# Pull production config
$ dotenvrtdb --pull --eUrl=https://myapp.firebaseio.com/prod.json -e .env.production

# Pull staging config
$ dotenvrtdb --pull --eUrl=https://myapp.firebaseio.com/staging.json -e .env.staging

# Run with specific environment
$ dotenvrtdb -e .env.production -- node server.js
```

### CI/CD Integration

Store secrets in Firebase and pull them during deployment:

```yaml
# .github/workflows/deploy.yml
- name: Pull environment variables
  run: |
    npm install -g @tolaptrinhdh61-spec/dotenvrtdb
    dotenvrtdb --pull --eUrl="${{ secrets.FIREBASE_ENV_URL }}" -e .env.production

- name: Deploy application
  run: dotenvrtdb -e .env.production -- npm run deploy
```

### Development Workflow

```bash
# Developer pulls latest shared config
$ dotenvrtdb --pull --eUrl=https://dev-db.firebaseio.com/config.json -e .env.development

# Make local changes and test
$ dotenvrtdb -e .env.development -- npm run dev

# Push updated config back (if authorized)
$ dotenvrtdb --push --eUrl=https://dev-db.firebaseio.com/config.json -e .env.development
```

## Remote Database Format

The remote database should return JSON in the following format:

```json
{
  "DATABASE_URL": "postgresql://localhost:5432/mydb",
  "API_KEY": "your-api-key-here",
  "NODE_ENV": "production",
  "PORT": "3000"
}
```

This will be converted to `.env` format:

```
DATABASE_URL=postgresql://localhost:5432/mydb
API_KEY=your-api-key-here
NODE_ENV=production
PORT=3000
```

## Security Features

### 🔒 Automatic Auth Token Masking

dotenvrtdb automatically masks sensitive information in URLs when displaying console output:

```bash
# Your command
$ dotenvrtdb --pull --eUrl="https://myapp.firebaseio.com/env.json?auth=AIzaSyAbc123XYZ"

# Console output (auth token is masked)
Pulling environment variables from https://myapp.firebaseio.com/env.json?auth=******...
✓ Successfully pulled environment variables to .env
```

Masked parameters include:

- `auth`
- `token`
- `key`
- `secret`
- `apikey`
- `api_key`

Username and password in URLs are also automatically masked:

```
https://user:password@example.com → https://******:******@example.com
```

### ⚠️ Important Security Notes

- Never commit `.env` files containing sensitive data to version control
- Use Firebase Security Rules to restrict access to your env database
- For production secrets, consider using environment-specific databases with proper authentication
- The `--pull` command requires read access to the database URL
- The `--push` command requires write access to the database URL

Example Firebase Security Rules:

```json
{
  "rules": {
    "env": {
      ".read": "auth != null",
      ".write": "auth != null && auth.token.admin === true"
    }
  }
}
```

## Supported Databases

dotenvrtdb works with any HTTP/HTTPS endpoint that:

- Returns JSON in key-value format (for pull)
- Accepts JSON via PUT/POST request (for push)

### Compatible services:

- ✅ Firebase Realtime Database
- ✅ Custom REST APIs
- ✅ Any HTTP/HTTPS JSON endpoint
- ✅ Cloud Functions
- ✅ Serverless endpoints

## Migration from dotenv-cli

If you're currently using `dotenv-cli`, you can switch to `dotenvrtdb` with zero breaking changes:

```bash
# Replace
$ dotenv -- node app.js

# With
$ dotenvrtdb -- node app.js
```

All existing flags and features work exactly the same way!

## Examples

### Basic Examples

```bash
# Load .env and run node app
$ dotenvrtdb -- node app.js

# Load custom env file
$ dotenvrtdb -e .env.local -- npm start

# Print environment variable
$ dotenvrtdb -p DATABASE_URL

# Set variables from command line
$ dotenvrtdb -v PORT=3000 -v HOST=localhost -- node server.js
```

### Remote Database Examples

```bash
# Pull from Firebase with auth token
$ dotenvrtdb --pull --eUrl="https://myapp.firebaseio.com/config.json?auth=YOUR_TOKEN" -e .env

# Push to custom API endpoint
$ dotenvrtdb --push --eUrl="https://api.myapp.com/env" -e .env.production

# Pull and immediately use
$ dotenvrtdb --pull --eUrl="https://myapp.firebaseio.com/env.json?auth=TOKEN" -e .env.temp && \
  dotenvrtdb -e .env.temp -- node app.js
```

### Advanced Examples

```bash
# Cascade with remote sync
$ dotenvrtdb --pull --eUrl="https://firebase.com/base.json" -e .env
$ dotenvrtdb -e .env -c production -- node app.js

# Multiple env files with priority
$ dotenvrtdb -e .env.local -e .env.shared -- npm run build

# Override system variables
$ dotenvrtdb -e .env.test -o -- jest
```

## Package Information

- **Package**: `@tolaptrinhdh61-spec/dotenvrtdb`
- **Command**: `dotenvrtdb`
- **Version**: 11.0.3
- **Repository**: https://github.com/tolaptrinhdh61-spec/dotenvrtdb

## Contributing

Issues and pull requests are welcome! Please visit our [GitHub repository](https://github.com/tolaptrinhdh61-spec/dotenvrtdb).

## License

[MIT](https://en.wikipedia.org/wiki/MIT_License)

## Credits

Based on [dotenv-cli](https://github.com/entropitor/dotenv-cli) with added remote database synchronization features.

---

Made with ❤️ by [tolaptrinhdh61-spec](https://github.com/tolaptrinhdh61-spec)
