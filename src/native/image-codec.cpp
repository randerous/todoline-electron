#include <windows.h>
#include <wincodec.h>
#include <cstdio>
#include <vector>
#include <io.h>
#include <fcntl.h>
#include <cstdint>

// Decode bytes from stdin, emit a PNG preview to stdout. No filesystem paths.
template<class T> struct Com {
    T* p = nullptr;
    ~Com() { if (p) p->Release(); }
    T** address() { return &p; }
    T* operator->() { return p; }
};
static void check(HRESULT hr) { if (FAILED(hr)) throw hr; }
static int convert() {
    constexpr size_t maxInput = 100 * 1024 * 1024, maxOutput = 256 * 1024 * 1024;
    std::vector<BYTE> input;
    BYTE chunk[65536]; size_t count;
    while ((count = fread(chunk, 1, sizeof(chunk), stdin))) {
        if (input.size() + count > maxInput) return 2;
        input.insert(input.end(), chunk, chunk + count);
    }
    if (ferror(stdin) || input.empty()) return 2;
    Com<IWICImagingFactory> factory;
    check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
        IID_IWICImagingFactory, reinterpret_cast<void**>(factory.address())));
    Com<IWICStream> source;
    check(factory->CreateStream(source.address()));
    check(source->InitializeFromMemory(input.data(), static_cast<DWORD>(input.size())));
    Com<IWICBitmapDecoder> decoder;
    check(factory->CreateDecoderFromStream(source.p, nullptr, WICDecodeMetadataCacheOnDemand, decoder.address()));
    GUID container; check(decoder->GetContainerFormat(&container));
    if (container != GUID_ContainerFormatTiff && container != GUID_ContainerFormatBmp && container != GUID_ContainerFormatIco) return 2;
    // Qt's QImage::fromData uses frame zero for both multi-page TIFF and multi-size ICO.
    Com<IWICBitmapFrameDecode> frame; UINT width, height;
    check(decoder->GetFrame(0, frame.address())); check(frame->GetSize(&width, &height));
    if (!width || !height || width > 32768 || height > 32768 || uint64_t(width) * height > 64000000) return 3;
    Com<IWICFormatConverter> pixels;
    check(factory->CreateFormatConverter(pixels.address()));
    check(pixels->Initialize(frame.p, GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));
    Com<IStream> output; check(CreateStreamOnHGlobal(nullptr, TRUE, output.address()));
    Com<IWICBitmapEncoder> encoder;
    check(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.address()));
    check(encoder->Initialize(output.p, WICBitmapEncoderNoCache));
    Com<IWICBitmapFrameEncode> encoded;
    check(encoder->CreateNewFrame(encoded.address(), nullptr)); check(encoded->Initialize(nullptr));
    check(encoded->SetSize(width, height)); check(encoded->SetResolution(96, 96));
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA; check(encoded->SetPixelFormat(&format));
    check(encoded->WriteSource(pixels.p, nullptr)); check(encoded->Commit()); check(encoder->Commit());
    STATSTG stats{}; check(output->Stat(&stats, STATFLAG_NONAME));
    if (!stats.cbSize.QuadPart || stats.cbSize.QuadPart > maxOutput) return 3;
    LARGE_INTEGER zero{}; check(output->Seek(zero, STREAM_SEEK_SET, nullptr));
    for (uint64_t remaining = stats.cbSize.QuadPart; remaining;) {
        ULONG n = 0, requested = static_cast<ULONG>(remaining < sizeof(chunk) ? remaining : sizeof(chunk));
        check(output->Read(chunk, requested, &n));
        if (!n || fwrite(chunk, 1, n, stdout) != n) return 4;
        remaining -= n;
    }
    return fflush(stdout) == 0 ? 0 : 4;
}
int main() {
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
    if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 5;
    int result; try { result = convert(); } catch (...) { result = 2; }
    CoUninitialize(); return result;
}
