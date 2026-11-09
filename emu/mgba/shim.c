// Oakle's GBA emulator: mGBA (MPL-2.0) behind the same C API the page, the audit job and the tests already call on
// binjgb (the Game Boy core in public/emu/binjgb.*), so src/emu.ts, replay() in src/rom.ts and scripts/emu.cjs run it
// unchanged. Built to public/emu/mgba.{js,wasm} by emu/mgba/build.sh.
//
// Time is whole frames: "ticks" = frames run * 280896 (GBA cycles per frame) and run_until runs a frame at a time, so a
// button change always lands on a frame boundary, which is the only place a GBA game ever looks at the keys. That makes
// replaying an input log deterministic by construction, with no sub-frame timing to get wrong.
#include <emscripten.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <mgba/core/core.h>
#include <mgba/core/config.h>
#include <mgba/core/log.h>
#include <mgba/core/blip_buf.h>
#include <mgba/core/interface.h>
#include <mgba/gba/interface.h>
#include <mgba/internal/gba/input.h>
#include <mgba-util/vfs.h>

#define TICKS_PER_FRAME 280896.0
#define W GBA_VIDEO_HORIZONTAL_PIXELS
#define H GBA_VIDEO_VERTICAL_PIXELS
#define EV_NEW_FRAME 1
#define EV_AUDIO_FULL 2
#define EV_UNTIL 4
#define AUDIO_RATE 32768 // must match emu.audio.rate in src/games.ts
#define AUDIO_RING 16384 // stereo frames kept when nobody reads (replay, audit)

static void quiet(struct mLogger* l, int category, enum mLogLevel level, const char* format, va_list args) { (void) l; (void) category; (void) level; (void) format; (void) args; }
static struct mLogger silent = {quiet, NULL}; // mGBA logs every DMA and BIOS call: thousands of lines a second

typedef struct { uint8_t* ptr; size_t size; } FileData;

typedef struct {
	struct mCore* core;
	void* rom;
	uint32_t* video; // mGBA's own pixels
	uint8_t* rgba;   // what the page draws: the same pixels with alpha forced opaque
	int16_t* audio;  // interleaved stereo, `audioN` frames waiting
	size_t audioN, audioWant;
	size_t consumed; // frames the page took on its last read
	uint32_t keys;
#ifdef OAKLE_DEBUG
	uint32_t dbgDrained;
#endif
} Emu;

#define KEY(name, bit) EMSCRIPTEN_KEEPALIVE void set_joyp_##name(Emu* e, int down) { if (down) e->keys |= 1u << (bit); else e->keys &= ~(1u << (bit)); }
KEY(up, GBA_KEY_UP) KEY(down, GBA_KEY_DOWN) KEY(left, GBA_KEY_LEFT) KEY(right, GBA_KEY_RIGHT)
KEY(A, GBA_KEY_A) KEY(B, GBA_KEY_B) KEY(start, GBA_KEY_START) KEY(select, GBA_KEY_SELECT)

// binjgb asks for a joypad object and a callback; here the keys live on the emulator, so these only keep callers happy
EMSCRIPTEN_KEEPALIVE void* joypad_new(void) { return malloc(1); }
EMSCRIPTEN_KEEPALIVE void joypad_delete(void* j) { free(j); }
EMSCRIPTEN_KEEPALIVE void emulator_set_default_joypad_callback(Emu* e, void* j) { (void) e; (void) j; }

// `audioFrames` is how many stereo frames one AUDIO_BUFFER_FULL hands over; the sample rate is mGBA's native 32768 Hz
// (the page builds its audio buffers at that rate and lets the browser resample)
EMSCRIPTEN_KEEPALIVE Emu* emulator_new_simple(const void* rom, size_t size, int sampleRate, int audioFrames, int curve) {
	(void) sampleRate; (void) curve;
	mLogSetDefaultLogger(&silent);
	Emu* e = calloc(1, sizeof(Emu));
	e->core = mCoreCreate(mPLATFORM_GBA);
	if (!e->core) { free(e); return NULL; }
	e->core->init(e->core);
	mCoreInitConfig(e->core, NULL); // reset and the audio code read their settings from here: it must exist (no config file in the browser)
	// the defaults a frontend gives mGBA: without volume 0x100 the master volume is 0 and the game is silent
	struct mCoreOptions opts = {.useBios = false, .audioBuffers = 1024, .volume = 0x100, .videoSync = false, .audioSync = false};
	mCoreConfigLoadDefaults(&e->core->config, &opts);
	mCoreLoadConfig(e->core);
	e->video = calloc(W * H, 4);
	e->rgba = calloc(W * H, 4);
	e->audio = calloc(AUDIO_RING + 4096, 4);
	e->audioWant = audioFrames;
	e->core->setVideoBuffer(e->core, e->video, W);
	e->core->setAudioBufferSize(e->core, 1024);
	e->rom = malloc(size);
	memcpy(e->rom, rom, size);
	struct VFile* vf = VFileFromMemory(e->rom, size);
	if (!e->core->loadROM(e->core, vf)) { e->core->deinit(e->core); free(e->rom); free(e->video); free(e->rgba); free(e->audio); free(e); return NULL; }
	// the game's clock must not follow the wall clock, or a replay a day later would not be the game the player played
	e->core->rtc.override = RTC_FIXED;
	e->core->rtc.value = 1700000000000LL; // ms since the epoch
	e->core->reset(e->core);
	// the frontend owns the output rate: without this mGBA's audio channels never produce a sample (silence)
	blip_set_rates(e->core->getAudioChannel(e->core, 0), e->core->frequency(e->core), AUDIO_RATE);
	blip_set_rates(e->core->getAudioChannel(e->core, 1), e->core->frequency(e->core), AUDIO_RATE);
	return e;
}

EMSCRIPTEN_KEEPALIVE void emulator_delete(Emu* e) {
	mCoreConfigDeinit(&e->core->config);
	e->core->deinit(e->core);
	free(e->rom); free(e->video); free(e->rgba); free(e->audio); free(e);
}

EMSCRIPTEN_KEEPALIVE double emulator_get_ticks_f64(Emu* e) { return (double) e->core->frameCounter(e->core) * TICKS_PER_FRAME; }

static void drain_audio(Emu* e) {
	struct blip_t* l = e->core->getAudioChannel(e->core, 0);
	struct blip_t* r = e->core->getAudioChannel(e->core, 1);
	int n = blip_samples_avail(l);
	if (n > 4096) n = 4096;
	if (e->audioN + n > AUDIO_RING) { // nobody is listening: keep the newest
		size_t drop = e->audioN + n - AUDIO_RING;
		memmove(e->audio, e->audio + drop * 2, (e->audioN - drop) * 4);
		e->audioN -= drop;
	}
	blip_read_samples(l, e->audio + e->audioN * 2, n, 1);
	blip_read_samples(r, e->audio + e->audioN * 2 + 1, n, 1);
	e->audioN += n;
#ifdef OAKLE_DEBUG
	e->dbgDrained += n;
#endif
}

// Runs one frame if the clock is still short of `until`. Returns the events that happened (bit 1 new frame, 2 audio buffer full, 4 reached `until`).
EMSCRIPTEN_KEEPALIVE int emulator_run_until_f64(Emu* e, double until) {
	int ev = 0;
	if (e->consumed) { // the page has read the last full buffer: drop it
		memmove(e->audio, e->audio + e->consumed * 2, (e->audioN - e->consumed) * 4);
		e->audioN -= e->consumed; e->consumed = 0;
	}
	if (emulator_get_ticks_f64(e) < until) {
		e->core->setKeys(e->core, e->keys);
		e->core->runFrame(e->core);
		drain_audio(e);
		for (int i = 0; i < W * H; i++) ((uint32_t*) e->rgba)[i] = e->video[i] | 0xff000000u;
		ev |= EV_NEW_FRAME;
		if (e->audioN >= e->audioWant) { ev |= EV_AUDIO_FULL; e->consumed = e->audioWant; }
	}
	if (emulator_get_ticks_f64(e) >= until) ev |= EV_UNTIL;
	return ev;
}

EMSCRIPTEN_KEEPALIVE int emulator_read_mem(Emu* e, uint32_t addr) { return e->core->rawRead8(e->core, addr, -1); }

EMSCRIPTEN_KEEPALIVE void* get_frame_buffer_ptr(Emu* e) { return e->rgba; }
EMSCRIPTEN_KEEPALIVE int get_frame_buffer_size(Emu* e) { (void) e; return W * H * 4; }
EMSCRIPTEN_KEEPALIVE void* get_audio_buffer_ptr(Emu* e) { return e->audio; }
EMSCRIPTEN_KEEPALIVE int get_audio_buffer_capacity(Emu* e) { return (int) e->audioWant * 4; } // bytes: s16 stereo

// ---- files: the cartridge's save memory (flash) and save states. new = allocate, write_* = emulator -> file, read_* = file -> emulator
EMSCRIPTEN_KEEPALIVE void* ext_ram_file_data_new(Emu* e) {
	FileData* f = calloc(1, sizeof(FileData));
	void* sram = NULL;
	f->size = e->core->savedataClone(e->core, &sram);
	f->ptr = sram;
	if (!f->ptr) { f->size = 0; }
	return f;
}
EMSCRIPTEN_KEEPALIVE void emulator_write_ext_ram(Emu* e, FileData* f) { // ext_ram_file_data_new already holds a copy taken just now
	(void) e; (void) f;
}
EMSCRIPTEN_KEEPALIVE void* state_file_data_new(Emu* e) {
	FileData* f = calloc(1, sizeof(FileData));
	f->size = e->core->stateSize(e->core);
	f->ptr = malloc(f->size);
	return f;
}
EMSCRIPTEN_KEEPALIVE void emulator_write_state(Emu* e, FileData* f) { e->core->saveState(e->core, f->ptr); }
EMSCRIPTEN_KEEPALIVE void emulator_read_state(Emu* e, FileData* f) {
	e->core->loadState(e->core, f->ptr);
	e->audioN = 0; e->consumed = 0;
	e->keys = e->core->getKeys(e->core); // the page releases anything the saved game still held (InputLog.resume)
}
EMSCRIPTEN_KEEPALIVE void* get_file_data_ptr(FileData* f) { return f->ptr; }
EMSCRIPTEN_KEEPALIVE int get_file_data_size(FileData* f) { return (int) f->size; }
EMSCRIPTEN_KEEPALIVE void file_data_delete(FileData* f) { free(f->ptr); free(f); }

#ifdef OAKLE_DEBUG // not in the shipped build: single-step the CPU and read a register, for finding who calls what
EMSCRIPTEN_KEEPALIVE uint32_t dbg_drained(Emu* e) { return e->dbgDrained; }
EMSCRIPTEN_KEEPALIVE void dbg_step(Emu* e) { e->core->step(e->core); }
EMSCRIPTEN_KEEPALIVE uint32_t dbg_reg(Emu* e, int n) { char name[8]; uint32_t v = 0; sprintf(name, "r%d", n); e->core->readRegister(e->core, name, &v); return v; }
#endif
