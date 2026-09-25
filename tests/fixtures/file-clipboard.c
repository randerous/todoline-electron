#define WIN32_LEAN_AND_MEAN
#include <windows.h>
/* Test-only producer: publish raw CF_HDROP with no Qt or Chromium MIME data. */
int main(int argc,char**argv){
  if(argc!=2)return 2;HANDLE file=CreateFileA(argv[1],GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,0,NULL);if(file==INVALID_HANDLE_VALUE)return 3;
  DWORD size=GetFileSize(file,NULL);if(!size||size>2*1024*1024){CloseHandle(file);return 4;}HGLOBAL block=GlobalAlloc(GMEM_MOVEABLE,size);if(!block){CloseHandle(file);return 4;}
  void* bytes=GlobalLock(block);DWORD read=0;int ok=bytes&&ReadFile(file,bytes,size,&read,NULL)&&read==size;GlobalUnlock(block);CloseHandle(file);if(!ok){GlobalFree(block);return 4;}
  HWND owner=CreateWindowExW(0,L"STATIC",L"TodoLine clipboard test",0,0,0,0,0,HWND_MESSAGE,NULL,GetModuleHandleW(NULL),NULL);if(!owner){GlobalFree(block);return 5;}
  int opened=0;for(int i=0;i<100;i++){if(OpenClipboard(owner)){opened=1;break;}Sleep(10);}if(!opened){GlobalFree(block);DestroyWindow(owner);return 5;}
  ok=EmptyClipboard()&&SetClipboardData(CF_HDROP,block);if(!ok)GlobalFree(block);CloseClipboard();DestroyWindow(owner);return ok?0:6;
}
