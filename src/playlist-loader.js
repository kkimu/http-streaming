/**
 * @file playlist-loader.js
 *
 * A state machine that manages the loading, caching, and updating of
 * M3U8 playlists.
 *
 */
import { resolveUrl, resolveManifestRedirect } from './resolve-url';
import videojs from 'video.js';
import { Parser as M3u8Parser } from 'm3u8-parser';
import window from 'global/window';

const { mergeOptions, EventTarget, log } = videojs;

/**
 * Loops through all supported media groups in master and calls the provided
 * callback for each group
 *
 * @param {Object} master
 *        The parsed master manifest object
 * @param {Function} callback
 *        Callback to call for each media group
 */
export const forEachMediaGroup = (master, callback) => {
  ['AUDIO', 'SUBTITLES'].forEach((mediaType) => {
    for (const groupKey in master.mediaGroups[mediaType]) {
      for (const labelKey in master.mediaGroups[mediaType][groupKey]) {
        const mediaProperties = master.mediaGroups[mediaType][groupKey][labelKey];

        callback(mediaProperties, mediaType, groupKey, labelKey);
      }
    }
  });
};

/**
  * Returns a new array of segments that is the result of merging
  * properties from an older list of segments onto an updated
  * list. No properties on the updated playlist will be overridden.
  *
  * @param {Array} original the outdated list of segments
  * @param {Array} update the updated list of segments
  * @param {number=} offset the index of the first update
  * segment in the original segment list. For non-live playlists,
  * this should always be zero and does not need to be
  * specified. For live playlists, it should be the difference
  * between the media sequence numbers in the original and updated
  * playlists.
  * @return a list of merged segment objects
  */
export const updateSegments = (original, update, offset) => {
  const result = update.slice();

  offset = offset || 0;
  const length = Math.min(original.length, update.length + offset);

  for (let i = offset; i < length; i++) {
    result[i - offset] = mergeOptions(original[i], result[i - offset]);
  }
  return result;
};

export const resolveSegmentUris = (segment, baseUri) => {
  if (!segment.resolvedUri) {
    segment.resolvedUri = resolveUrl(baseUri, segment.uri);
  }
  if (segment.key && !segment.key.resolvedUri) {
    segment.key.resolvedUri = resolveUrl(baseUri, segment.key.uri);
  }
  if (segment.map && !segment.map.resolvedUri) {
    segment.map.resolvedUri = resolveUrl(baseUri, segment.map.uri);
  }
};

/**
  * Returns a new master playlist that is the result of merging an
  * updated media playlist into the original version. If the
  * updated media playlist does not match any of the playlist
  * entries in the original master playlist, null is returned.
  *
  * @param {Object} master a parsed master M3U8 object
  * @param {Object} media a parsed media M3U8 object
  * @return {Object} a new object that represents the original
  * master playlist with the updated media playlist merged in, or
  * null if the merge produced no change.
  */
export const updateMaster = (master, media) => {
  const result = mergeOptions(master, {});
  const playlist = result.playlists[media.id];

  if (!playlist) {
    return null;
  }

  // consider the playlist unchanged if the number of segments is equal, the media
  // sequence number is unchanged, and this playlist hasn't become the end of the playlist
  if (playlist.segments &&
      media.segments &&
      playlist.segments.length === media.segments.length &&
      playlist.endList === media.endList &&
      playlist.mediaSequence === media.mediaSequence) {
    return null;
  }

  const mergedPlaylist = mergeOptions(playlist, media);

  // if the update could overlap existing segment information, merge the two segment lists
  if (playlist.segments) {
    mergedPlaylist.segments = updateSegments(
      playlist.segments,
      media.segments,
      media.mediaSequence - playlist.mediaSequence
    );
  }

  // resolve any segment URIs to prevent us from having to do it later
  mergedPlaylist.segments.forEach((segment) => {
    resolveSegmentUris(segment, mergedPlaylist.resolvedUri);
  });

  // TODO Right now in the playlists array there are two references to each playlist, one
  // that is referenced by index, and one by URI. The index reference may no longer be
  // necessary.
  for (let i = 0; i < result.playlists.length; i++) {
    if (result.playlists[i].id === media.id) {
      result.playlists[i] = mergedPlaylist;
    }
  }
  result.playlists[media.id] = mergedPlaylist;
  // URI reference added for backwards compatibility
  result.playlists[media.uri] = mergedPlaylist;

  return result;
};

export const createPlaylistID = (index, uri) => {
  return `${index}-${uri}`;
};

export const setupMediaPlaylists = (master) => {
  // setup by-URI lookups and resolve media playlist URIs
  let i = master.playlists.length;

  while (i--) {
    const playlist = master.playlists[i];

    playlist.resolvedUri = resolveUrl(master.uri, playlist.uri);
    playlist.id = createPlaylistID(i, playlist.uri);

    master.playlists[playlist.id] = playlist;
    // URI reference added for backwards compatibility
    master.playlists[playlist.uri] = playlist;

    if (!playlist.attributes) {
      // Although the spec states an #EXT-X-STREAM-INF tag MUST have a
      // BANDWIDTH attribute, we can play the stream without it. This means a poorly
      // formatted master playlist may not have an attribute list. An attributes
      // property is added here to prevent undefined references when we encounter
      // this scenario.
      playlist.attributes = {};

      log.warn('Invalid playlist STREAM-INF detected. Missing BANDWIDTH attribute.');
    }
  }
};

export const resolveMediaGroupUris = (master) => {
  forEachMediaGroup(master, (properties) => {
    if (properties.uri) {
      properties.resolvedUri = resolveUrl(master.uri, properties.uri);
    }
  });
};

/**
 * Calculates the time to wait before refreshing a live playlist
 *
 * @param {Object} media
 *        The current media
 * @param {boolean} update
 *        True if there were any updates from the last refresh, false otherwise
 * @return {number}
 *         The time in ms to wait before refreshing the live playlist
 */
export const refreshDelay = (media, update) => {
  const lastSegment = media.segments[media.segments.length - 1];
  let delay;

  if (update && lastSegment && lastSegment.duration) {
    delay = lastSegment.duration * 1000;
  } else {
    // if the playlist is unchanged since the last reload or last segment duration
    // cannot be determined, try again after half the target duration
    delay = (media.targetDuration || 10) * 500;
  }
  return delay;
};

/**
 * Load a playlist from a remote location
 *
 * @class PlaylistLoader
 * @extends Stream
 * @param {string} srcUrl the url to start with
 * @param {boolean} withCredentials the withCredentials xhr option
 * @class
 */
export default class PlaylistLoader extends EventTarget {
  constructor(srcUrl, hls, options = { }) {
    super();

    const { withCredentials = false, handleManifestRedirects = false } = options;

    this.srcUrl = srcUrl;
    this.hls_ = hls;
    this.withCredentials = withCredentials;
    this.handleManifestRedirects = handleManifestRedirects;

    const hlsOptions = hls.options_;

    this.customTagParsers = (hlsOptions && hlsOptions.customTagParsers) || [];
    this.customTagMappers = (hlsOptions && hlsOptions.customTagMappers) || [];

    if (!this.srcUrl) {
      throw new Error('A non-empty playlist URL is required');
    }

    // initialize the loader state
    this.state = 'HAVE_NOTHING';

    // live playlist staleness timeout
    this.on('mediaupdatetimeout', () => {
      if (this.state !== 'HAVE_METADATA') {
        // only refresh the media playlist if no other activity is going on
        return;
      }

      this.state = 'HAVE_CURRENT_METADATA';

      this.request = this.hls_.xhr({
        uri: resolveUrl(this.master.uri, this.media().uri),
        withCredentials: this.withCredentials
      }, (error, req) => {
        // disposed
        if (!this.request) {
          return;
        }

        if (error) {
          return this.playlistRequestError(this.request, this.media(), 'HAVE_METADATA');
        }

        this.haveMetadata(this.request, this.media().uri, this.media().id);
      });
    });
  }

  playlistRequestError(xhr, playlist, startingState) {
    const {
      uri,
      id
    } = playlist;

    // any in-flight request is now finished
    this.request = null;

    if (startingState) {
      this.state = startingState;
    }

    this.error = {
      playlist: this.master.playlists[id],
      status: xhr.status,
      message: `HLS playlist request error at URL: ${uri}.`,
      responseText: xhr.responseText,
      code: (xhr.status >= 500) ? 4 : 2
    };

    this.trigger('error');
  }

  // update the playlist loader's state in response to a new or
  // updated playlist.
  haveMetadata(xhr, url, id) {
    // any in-flight request is now finished
    this.request = null;
    this.state = 'HAVE_METADATA';

    const parser = new M3u8Parser();

    // adding custom tag parsers
    this.customTagParsers.forEach(customParser => parser.addParser(customParser));

    // adding custom tag mappers
    this.customTagMappers.forEach(mapper => parser.addTagMapper(mapper));

    parser.push(xhr.responseText);
    parser.end();
    parser.manifest.uri = url;
    parser.manifest.id = id;
    // m3u8-parser does not attach an attributes property to media playlists so make
    // sure that the property is attached to avoid undefined reference errors
    parser.manifest.attributes = parser.manifest.attributes || {};

    // merge this playlist into the master
    const update = updateMaster(this.master, parser.manifest);

    this.targetDuration = parser.manifest.targetDuration;

    if (update) {
      this.master = update;
      this.media_ = this.master.playlists[id];
    } else {
      this.trigger('playlistunchanged');
    }

    // refresh live playlists after a target duration passes
    if (!this.media().endList) {
      window.clearTimeout(this.mediaUpdateTimeout);
      this.mediaUpdateTimeout = window.setTimeout(() => {
        this.trigger('mediaupdatetimeout');
      }, refreshDelay(this.media(), !!update));
    }

    this.trigger('loadedplaylist');
  }

  /**
    * Abort any outstanding work and clean up.
    */
  dispose() {
    this.stopRequest();
    window.clearTimeout(this.mediaUpdateTimeout);
    window.clearTimeout(this.finalRenditionTimeout);
  }

  stopRequest() {
    if (this.request) {
      const oldRequest = this.request;

      this.request = null;
      oldRequest.onreadystatechange = null;
      oldRequest.abort();
    }
  }

  /**
    * When called without any arguments, returns the currently
    * active media playlist. When called with a single argument,
    * triggers the playlist loader to asynchronously switch to the
    * specified media playlist. Calling this method while the
    * loader is in the HAVE_NOTHING causes an error to be emitted
    * but otherwise has no effect.
    *
    * @param {Object=} playlist the parsed media playlist
    * object to switch to
    * @param {boolean=} is this the last available playlist
    *
    * @return {Playlist} the current loaded media
    */
  media(playlist, isFinalRendition) {
    // getter
    if (!playlist) {
      return this.media_;
    }

    // setter
    if (this.state === 'HAVE_NOTHING') {
      throw new Error('Cannot switch media playlist from ' + this.state);
    }

    // find the playlist object if the target playlist has been
    // specified by URI
    if (typeof playlist === 'string') {
      if (!this.master.playlists[playlist]) {
        throw new Error('Unknown playlist URI: ' + playlist);
      }
      playlist = this.master.playlists[playlist];
    }

    window.clearTimeout(this.finalRenditionTimeout);

    if (isFinalRendition) {
      const delay = (playlist.targetDuration / 2) * 1000 || 5 * 1000;

      this.finalRenditionTimeout =
        window.setTimeout(this.media.bind(this, playlist, false), delay);
      return;
    }

    const startingState = this.state;
    const mediaChange = !this.media_ || playlist.id !== this.media_.id;

    // switch to fully loaded playlists immediately
    if (this.master.playlists[playlist.id].endList) {
      // abort outstanding playlist requests
      if (this.request) {
        this.request.onreadystatechange = null;
        this.request.abort();
        this.request = null;
      }
      this.state = 'HAVE_METADATA';
      this.media_ = playlist;

      // trigger media change if the active media has been updated
      if (mediaChange) {
        this.trigger('mediachanging');
        this.trigger('mediachange');
      }
      return;
    }

    // switching to the active playlist is a no-op
    if (!mediaChange) {
      return;
    }

    this.state = 'SWITCHING_MEDIA';

    // there is already an outstanding playlist request
    if (this.request) {
      if (playlist.resolvedUri === this.request.url) {
        // requesting to switch to the same playlist multiple times
        // has no effect after the first
        return;
      }
      this.request.onreadystatechange = null;
      this.request.abort();
      this.request = null;
    }

    // request the new playlist
    if (this.media_) {
      this.trigger('mediachanging');
    }

    this.request = this.hls_.xhr({
      uri: playlist.resolvedUri,
      withCredentials: this.withCredentials
    }, (error, req) => {
      // disposed
      if (!this.request) {
        return;
      }

      playlist.resolvedUri = resolveManifestRedirect(this.handleManifestRedirects, playlist.resolvedUri, req);

      if (error) {
        return this.playlistRequestError(this.request, playlist, startingState);
      }

      this.haveMetadata(req, playlist.uri, playlist.id);

      // fire loadedmetadata the first time a media playlist is loaded
      if (startingState === 'HAVE_MASTER') {
        this.trigger('loadedmetadata');
      } else {
        this.trigger('mediachange');
      }
    });
  }

  /**
   * pause loading of the playlist
   */
  pause() {
    this.stopRequest();
    window.clearTimeout(this.mediaUpdateTimeout);
    if (this.state === 'HAVE_NOTHING') {
      // If we pause the loader before any data has been retrieved, its as if we never
      // started, so reset to an unstarted state.
      this.started = false;
    }
    // Need to restore state now that no activity is happening
    if (this.state === 'SWITCHING_MEDIA') {
      // if the loader was in the process of switching media, it should either return to
      // HAVE_MASTER or HAVE_METADATA depending on if the loader has loaded a media
      // playlist yet. This is determined by the existence of loader.media_
      if (this.media_) {
        this.state = 'HAVE_METADATA';
      } else {
        this.state = 'HAVE_MASTER';
      }
    } else if (this.state === 'HAVE_CURRENT_METADATA') {
      this.state = 'HAVE_METADATA';
    }
  }

  /**
   * start loading of the playlist
   */
  load(isFinalRendition) {
    window.clearTimeout(this.mediaUpdateTimeout);

    const media = this.media();

    if (isFinalRendition) {
      const delay = media ? (media.targetDuration / 2) * 5000 : 5 * 5000;

      this.mediaUpdateTimeout = window.setTimeout(() => this.load(), delay);
      return;
    }

    if (!this.started) {
      this.start();
      return;
    }

    if (media && !media.endList) {
      this.trigger('mediaupdatetimeout');
    } else {
      this.trigger('loadedplaylist');
    }
  }

  /**
   * start loading of the playlist
   */
  start() {
    this.started = true;

    // request the specified URL
    this.request = this.hls_.xhr({
      uri: this.srcUrl,
      withCredentials: this.withCredentials
    }, (error, req) => {
      // disposed
      if (!this.request) {
        return;
      }

      // clear the loader's request reference
      this.request = null;

      if (error) {
        this.error = {
          status: req.status,
          message: `HLS playlist request error at URL: ${this.srcUrl}.`,
          responseText: req.responseText,
          // MEDIA_ERR_NETWORK
          code: 2
        };
        if (this.state === 'HAVE_NOTHING') {
          this.started = false;
        }
        return this.trigger('error');
      }

      const parser = new M3u8Parser();

      // adding custom tag parsers
      this.customTagParsers.forEach(customParser => parser.addParser(customParser));

      // adding custom tag mappers
      this.customTagMappers.forEach(mapper => parser.addTagMapper(mapper));

      parser.push(req.responseText);
      parser.end();

      this.state = 'HAVE_MASTER';

      this.srcUrl = resolveManifestRedirect(this.handleManifestRedirects, this.srcUrl, req);

      parser.manifest.uri = this.srcUrl;

      // loaded a master playlist
      if (parser.manifest.playlists) {
        this.master = parser.manifest;

        setupMediaPlaylists(this.master);
        resolveMediaGroupUris(this.master);

        this.trigger('loadedplaylist');
        if (!this.request) {
          // no media playlist was specifically selected so start
          // from the first listed one
          this.media(parser.manifest.playlists[0]);
        }
        return;
      }

      const id = createPlaylistID(0, this.srcUrl);

      // loaded a media playlist
      // infer a master playlist if none was previously requested
      this.master = {
        mediaGroups: {
          'AUDIO': {},
          'VIDEO': {},
          'CLOSED-CAPTIONS': {},
          'SUBTITLES': {}
        },
        uri: window.location.href,
        playlists: [{
          uri: this.srcUrl,
          id,
          resolvedUri: this.srcUrl,
          // m3u8-parser does not attach an attributes property to media playlists so make
          // sure that the property is attached to avoid undefined reference errors
          attributes: {}
        }]
      };
      this.master.playlists[id] = this.master.playlists[0];
      // URI reference added for backwards compatibility
      this.master.playlists[this.srcUrl] = this.master.playlists[0];

      this.haveMetadata(req, this.srcUrl, id);
      return this.trigger('loadedmetadata');
    });
  }
}
