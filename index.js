'use strict';

var Accessory, hap, UUIDGen, Service, Characteristic;

var http = require('http');
var https = require('https');
var URL = require('url');
var qs = require('qs');

var debug = require('debug')('camera-ffmpeg-ufv');
var UFV = require('./ufv.js').UFV;
var MotionSensorAccessory = require('./lib/motion-sensor-accessory');

var API = require('./lib/util/api');
const apiEndpoint = '/api/2.0';

module.exports = function(homebridge) {
  hap = homebridge.hap;
  UUIDGen = homebridge.hap.uuid;
  Accessory = homebridge.platformAccessory;
  Service = hap.Service,
  Characteristic = hap.Characteristic,

  homebridge.registerPlatform("homebridge-camera-ffmpeg-ufv", "camera-ffmpeg-ufv", ffmpegUfvPlatform, true);
}

function ffmpegUfvPlatform(log, config, api) {
  var self = this;

  self.log = log;
  self.config = config || {};
  self._accessories = [];
  self.motionCache = {};

  if (api) {
    self.api = api;

    if (api.version < 2.1) {
      throw new Error("Unexpected API version.");
    }

    self.api.on('didFinishLaunching', self.didFinishLaunching.bind(this));
  }
}

// Won't do anything
ffmpegUfvPlatform.prototype.didFinishLaunching = function() {

}

ffmpegUfvPlatform.prototype.accessories = function(callback) {
  var self = this;

  if (self.config.nvrs) {

    var configuredAccessories = [];

    var nvrs = self.config.nvrs;

    nvrs.forEach(function(nvrConfig) {

      // From the config we need the host and API key for the NVR.
      // - Host will be the NVR's hostname or IP and port, ie "nvr.example.com:7080"
      // - API key is created in NVR user settings
      var options = {
        host: nvrConfig.apiHost,
        port: nvrConfig.apiPort,
        path: apiEndpoint + '/bootstrap?apiKey=' + nvrConfig.apiKey,
        rejectUnauthorized: false // bypass the self-signed certificate error. Bleh
      };


      // Fetch the "bootstrap" file from the NVR,
      // which contains all the config info we need:

      (nvrConfig.apiProtocol == 'https' ? https : http ).get(options, function (res) {

        var json = '';

        res.on('data', function (chunk) {
          json += chunk;
        });

        res.on('end', function () {

          if (res.statusCode === 200) {

            try {
              var parsedResponse = JSON.parse(json);

              // At this point we should have the NVR configuration.

              var server;
              var serverName;
              var streamingHost;
              var streamingPort;
              var channels = [];

              // The root of the result is "data"
              var discoveredNvrs = parsedResponse.data;

              discoveredNvrs.forEach(function(discoveredNvr) {
                debug("Discovered NVR " + discoveredNvr.nvrName);

                // In the old API, the NVR knows the rtsp port.
                // If this is not defined, we'll look for it in the
                // channel definition later:
                streamingPort = discoveredNvr.systemInfo.rtspPort;

                // Within each NVR we should have one or more servers:
                var discoveredServers = discoveredNvr.servers;

                discoveredServers.forEach(function(discoveredServer) {
                  debug("Discovered server " + discoveredServer.name);

                  serverName = discoveredServer.name;

                  // Override Hostname for the streams:
                  streamingHost = nvrConfig.apiHost; // discoveredServer.host;

                  server = discoveredServer;

                });

                // Hack: there is at this time only one 'server' object.
                // We are assuming there will only be one.
                // If this changes, things will probably break!

                // Within each NVR we should have one or more cameras:
                var discoveredCameras = discoveredNvr.cameras;

                discoveredCameras.forEach(function(discoveredCamera) {
                  // Each camera has more than one channel.
                  // The channel is where the actual streaming params live:

                  var discoveredChannels = ( discoveredCamera.channels || [] );

                  // Go through each channel, see if it is rtspEnabled, and if so,
                  // post it to homebridge and move on to the next camera

                  for(var channelIndex = 0; channelIndex < discoveredChannels.length; channelIndex++) {

                    var discoveredChannel = discoveredChannels[channelIndex];

                    // Let's see if this channel has RSTP enabled:
                    if(discoveredChannel.isRtspEnabled == true) {
                      var rtspAlias = discoveredChannel.rtspAlias;

                      debug('Discovered RTSP enabled camera ' + discoveredCamera.uuid);

                      // Set the RTSP URI. Let's first try the new way (>=3.9.0), then try the old way.

                      if ( discoveredChannel.hasOwnProperty('rtspUris') ) {
                        var rtspUri = discoveredChannel.rtspUris[0];

                        // Since the Hostname isn't configurable from UFV admin, we can override the hostname here
                        var url = URL.parse(rtspUri, true);
                        url.hostname = nvrConfig.apiHost;
                        delete url.href;
                        delete url.host;
                        rtspUri = URL.format(url);

                        debug("Discovered server " + rtspUri);
                      } else {
                        var rtspUri = 'rtsp://' + streamingHost + ':' + streamingPort + '/' + rtspAlias;
                      }

                      // We should know have everything we need and can push it to
                      // UFV:

                      var videoConfig = {
                        "source": ('-rtsp_transport tcp -re -i ' + rtspUri + '?apiKey=' + nvrConfig.apiKey),
                        "stillImageSource": ((nvrConfig.apiProtocol == 'https' ? 'https' : 'http') + '://' + nvrConfig.apiHost + ':' + nvrConfig.apiPort + apiEndpoint + '/snapshot/camera/' + discoveredCamera._id + '?force=true&apiKey=' + nvrConfig.apiKey),
                        "maxStreams": 2,
                        "maxWidth": discoveredChannel.width, // or however we end up getting to this!
                        "maxHeight": discoveredChannel.height,
                        "maxFPS": discoveredChannel.fps,
                        "audio": nvrConfig.audio === true
                      };

                      debug('Config: ' + JSON.stringify(videoConfig));

                      // Create a new Accessory for this camera:
                      var cameraAccessory = new Accessory(discoveredCamera.name, discoveredCamera.uuid, hap.Accessory.Categories.CAMERA);
                      var cameraConfig = {name: discoveredCamera.name, videoConfig: videoConfig};
                      cameraAccessory
                      .getService(Service.AccessoryInformation)
                      .setCharacteristic(Characteristic.Manufacturer, "Ubiquiti Networks, Inc.")
                      .setCharacteristic(Characteristic.Model, discoveredCamera.model)
                      .setCharacteristic(Characteristic.SerialNumber, discoveredCamera.uuid)
                      .setCharacteristic(Characteristic.FirmwareRevision, discoveredCamera.firmwareVersion);

                      debug(JSON.stringify(cameraConfig));

                      var cameraSource = new UFV(hap, cameraConfig);
                      cameraAccessory.configureCameraSource(cameraSource);
                      configuredAccessories.push(cameraAccessory);

                      // Setup the Motion Sensors for this camera
                      if (nvrConfig.motionSensors === false) {
                        self.log('Skipping '+discoveredCamera.name+' Motion Sensor due to NVR config "motionSensors" disabled.');
                      } else if (discoveredCamera.recordingSettings.motionRecordEnabled) {
                        debug('Setting up Motion Sensor for: ' + discoveredCamera.name);
                        self.setupMotionSensor(hap, nvrConfig, discoveredNvr, server, discoveredCamera);
                      } else {
                        self.log('Skipping Motion Sensor due to motion recording not enabled for: ' + discoveredCamera.name);
                      }

                      // Jump out of the loop once we have one:
                      channelIndex = discoveredChannels.length;
                    };

                  };

                });

              });

              // Publish the cameras we found to homebridge:
              self.api.publishCameraAccessories("camera-ffmpeg-ufv", configuredAccessories);

              self.log('Published ' + configuredAccessories.length + ' camera accessories.');

            } catch (e) {
              debug('Error parsing JSON! ' + e);
            }

          } else {
            debug('Status:', res.statusCode);
          }

          callback(self._accessories);
        });

      }).on('error', function (err) {
        debug('Error:', err);
      });

    });
  }

}

ffmpegUfvPlatform.prototype.setupMotionSensor = function (homebridge, nvrConfig, discoveredNvr, discoveredServer, discoveredCamera) {
  var self = this;
  // Setup Motion Status Caching
  self.setupMotionCache(nvrConfig, discoveredNvr, discoveredServer, discoveredCamera);
  var nvrId = UUIDGen.generate(discoveredNvr.nvrName + nvrConfig.apiHost);
  // Setup Motion Sensor for this camera.
  var accessory = MotionSensorAccessory.createAccessory(hap, nvrConfig, discoveredCamera, self.motionCache[nvrId]);

  // Guarantee only one motion sensor for this camera
  for (var i in self.accessories) {
    var a = self.accessories[i];
    if (accessory.username == a.username) {
      accessory.destroy();
      return;
    }
  }

  debug('Discovered Motion Sensor enabled camera ' + discoveredCamera.uuid);

  var properties = new Object({
    platform: self,
    name: accessory.displayName,
    getServices : function(){
      return this.services;
    }
  });

  Object.assign(accessory, properties);

  this._accessories.push(accessory);
  // this.api.registerPlatformAccessories("homebridge-camera-ffmpeg-ufv", "camera-ffmpeg-ufv", [newAccessory])
}

ffmpegUfvPlatform.prototype.setupMotionCache = function (nvrConfig, discoveredNvr, discoveredServer, discoveredCamera) {

  var self = this;

  var nvrId = UUIDGen.generate(discoveredNvr.nvrName + nvrConfig.apiHost);
  if (self.motionCache.hasOwnProperty(nvrId)) {
    // This NVR is already caching
    debug('Motion Caching already setup for: ' + discoveredNvr.nvrName);
    return;
  }

  debug('Setting up motion cache for: ' + discoveredNvr.nvrName);

  // Setup cache object for all recordings on this NVR
  self.motionCache[nvrId] = [];

  // Within each NVR we should have one or more cameras:
  var discoveredCameras = discoveredNvr.cameras;
  var allCameras = discoveredCameras.map(function(discoveredCamera) {
      // return discoveredCamera.uuid;
      return discoveredCamera._id;
  })

  // Setup timer to cache recordings status
  setInterval(function () {
    // Setup timer to fetch cache for motion per nvr
    var now = Date.now();

    // My docker instance experiences time drift when running on a Mac. This helps with that.
    var twoHoursInTheFuture = 2 + 60 * 60 * 1000;

    // Set the minimum motion limit to 5 minutes in the past
    var motionDuration = discoveredServer.alertSettings.motionEmailCoolDownMs; // ms
    if (motionDuration < 60 * 1000 * 3) {
      motionDuration = 60 * 1000 * 3;
    }
    var options = {
        query: {
            // idsOnly: true,
            startTime: now - motionDuration,
            endTime: now + twoHoursInTheFuture,
            sortBy: 'startTime',
            sort: 'desc',
            cameras: allCameras,
            cause:[
                'motionRecording'
            ]
        }
    }
    API.get(apiEndpoint,'/recording', options, nvrConfig).then(function(json) {
        // Clear out the object since it's been passed by reference
        self.motionCache[nvrId].length = 0;
        json.data.map(function(recording) {
            self.motionCache[nvrId].push(recording);
        });
      })
  }, 1000);
}
