/*

This file is a part of ubports-installer

Author: Marius Gripsgard <mariogrip@ubports.com>

*/

const http = require("request");
const progress = require("request-progress");
const os = require("os");
const fs = require("fs-extra");
const path = require("path");
const checksum = require('checksum');
const mkdirp = require('mkdirp');
const tmp = require('tmp');
const exec = require('child_process').exec;
const sudo = require('electron-sudo');

const platforms = {
    "linux": "linux",
    "darwin": "mac",
    "win32": "win"
}

var log = (l) => {
  if(process.env.DEBUG){
    console.log(l);
  }
}

var getUbportDir = () => {
    return path.join(process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + 'Library/Preferences' : process.env.HOME + '/.cache'), needRoot() ? "ubports/": "ubports-root/")
}

var die = (e) => {
    console.log(e);
    process.exit(1);
}

// WORKAROUND: since we are using asar packages to compress into one package we cannot use
// child_process.exec since it spans a shell and shell wont be able to access the files
// inside the asar package.
var asarExec = (file, cmd, callback) => {
    tmp.dir((err, tmpDir, cleanup) => {
        if (err) callback(true);
        fs.copy(file, path.join(tmpDir, path.basename(file)), (err) => {
            fs.chmodSync(path.join(tmpDir, path.basename(file)), 0o755);
            if(err) die(err);
            cmd=cmd.replace(new RegExp(file, 'g'), path.join(tmpDir, path.basename(file)));
            exec(cmd, (err, e,r) => {
                fs.removeSync(tmpDir);
                console.log(err,e,r);
                callback(err);
            })
        })
    })

}

var maybeEXE = (platform, tool) => {
    if(platform === "win32") tool+=".exe";
    return tool;
}

var getPlatformTools = () => {
    var thisPlatform = os.platform();
    if(!platforms[thisPlatform]) die("Unsuported platform");
    var platfromToolsPath = path.join(__dirname, "/../platform-tools/", platforms[thisPlatform]);
    return {
        fastboot: path.join(platfromToolsPath, maybeEXE(thisPlatform, "fastboot")),
        adb: path.join(platfromToolsPath, maybeEXE(thisPlatform, "adb"))
    }
}

var isSnap = () => {
  return process.env.SNAP_NAME != null
}

var needRoot = () => {
    if (os.platform === "win32") return false;
    return !process.env.SUDO_UID
}

var ensureRoot = (m) => {
  if(process.env.SUDO_UID)
    return;
  console.log(m)
  process.exit(1);
}

var checkFiles = (urls, callback) => {
    var urls_ = [];
    var next = () => {
        if (urls.length <= 1) {
            callback(urls_)
        } else {
            urls.shift();
            check()
        }
    }
    var check = () => {
        fs.access(urls[0].path + "/" + path.basename(urls[0].url), (err) => {
            if (err) {
                log("Not existing " + urls[0].path + "/" + path.basename(urls[0].url))
                urls_.push(urls[0]);
                next();
            } else {
                checksumFile(urls[0], (check) => {
                    if (check) {
                        log("Exists " + urls[0].path + "/" + path.basename(urls[0].url))
                        next()
                    } else {
                        log("Checksum no match " + urls[0].path + "/" + path.basename(urls[0].url))
                        urls_.push(urls[0]);
                        next()
                    }
                })
            }
        })
    }
    check();
}

var checksumFile = (file, callback) => {
    if (!file.checksum) {
        // No checksum so return true;
        callback(true);
        return;
    }
    checksum.file(file.path + "/" + path.basename(file.url), {
        algorithm: "sha256"
    }, function(err, sum) {
        log("checked: " +path.basename(file.url), sum === file.checksum)
        callback(sum === file.checksum, sum)
    })
}

/*
urls format:
[
  {
    url: "http://test.com",
    path: ".bla/bal/",
    checksum: "d342j43lj34hgth324hj32ke4"
  }
]
*/
var downloadFiles = (urls_, downloadEvent) => {
    var urls;
    downloadEvent.emit("download:startCheck");
    var dl = () => {
        if (!fs.existsSync(urls[0].path)) {
            mkdirp.sync(urls[0].path);
        }
        progress(http(urls[0].url))
            .on('progress', (state) => {
                downloadEvent.emit("download:progress", state);
            })
            .on('error', (err) => {
                downloadEvent.emit("download:error", err)
            })
            .on('end', () => {
                fs.rename(urls[0].path + "/" + path.basename(urls[0].url) + ".tmp",
                    urls[0].path + "/" + path.basename(urls[0].url), () => {
                        downloadEvent.emit("download:checking");
                        checksumFile(urls[0], (check) => {
                            if (check) {
                                if (urls.length <= 1) {
                                    downloadEvent.emit("download:done");
                                } else {
                                    urls.shift();
                                    downloadEvent.emit("download:next", urls.length);
                                    dl()
                                }
                            } else {
                                downloadEvent.emit("download:error", "Checksum did not match on file " + path.basename(urls[0].url));
                            }
                        })
                    })
            })
            .pipe(fs.createWriteStream(urls[0].path + "/" + path.basename(urls[0].url) + ".tmp"));
    }
    checkFiles(urls_, (ret) => {
        if (ret.length <= 0) {
            downloadEvent.emit("download:done");
        } else {
            urls = ret;
            downloadEvent.emit("download:start", urls.length);
            dl();
        }
    })
    return downloadEvent;
}

module.exports = {
    downloadFiles: downloadFiles,
    checksumFile: checksumFile,
    checkFiles: checkFiles,
    log: log,
    asarExec: asarExec,
    ensureRoot: ensureRoot,
    isSnap: isSnap,
    getPlatformTools: getPlatformTools,
    getUbportDir: getUbportDir,
    needRoot: needRoot
}