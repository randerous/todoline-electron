#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <string.h>
#include <shellapi.h>
#include <shlobj.h>

/* https://learn.microsoft.com/windows/win32/dataxchg/using-the-clipboard
   All formats are prepared before opening the clipboard. No files, shell, or
   network access: stdin is a length-prefixed list of clipboard buffers only. */
static int read_exact(void* data,DWORD size){
  char* p=(char*)data;
  while(size){DWORD n=0;if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),p,size,&n,NULL)||!n)return 0;p+=n;size-=n;}
  return 1;
}
static int write_exact(const void* data,DWORD size){
  const char* p=(const char*)data;while(size){DWORD n=0;if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),p,size,&n,NULL)||!n)return 0;p+=n;size-=n;}return 1;
}
/* CF_HDROP owns a bounded, double-null-terminated filename list. Keep this
   helper limited to the clipboard; the main process opens image files only.
   https://learn.microsoft.com/windows/win32/shell/clipboard */
static int read_files(void){
  int opened=0;for(int retry=0;retry<100;retry++){if(OpenClipboard(NULL)){opened=1;break;}Sleep(10);}if(!opened)return 3;
  int result=2;uint32_t count=0;
  if(!IsClipboardFormatAvailable(CF_HDROP)){result=write_exact(&count,4)?0:5;goto done;}
  HGLOBAL block=GetClipboardData(CF_HDROP);if(!block)goto done;
  SIZE_T size=GlobalSize(block);if(size<sizeof(DROPFILES)||size>2u*1024u*1024u)goto done;
  const DROPFILES* drop=GlobalLock(block);if(!drop)goto done;
  DWORD offset=drop->pFiles;int wide=drop->fWide!=0,valid=0;
  if(offset>=sizeof(DROPFILES)&&offset<size&&(!wide||offset%2==0)){
    SIZE_T unit=wide?2:1,remaining=(size-offset)/unit;const unsigned char* data=(const unsigned char*)drop+offset;
    for(SIZE_T i=1;i<remaining;i++){
      int zero=wide?data[i*2]==0&&data[i*2+1]==0:data[i]==0;
      int previous=wide?data[(i-1)*2]==0&&data[(i-1)*2+1]==0:data[i-1]==0;
      if(zero&&previous){valid=1;break;}
    }
  }
  GlobalUnlock(block);if(!valid)goto done;
  count=DragQueryFileW((HDROP)block,0xffffffff,NULL,0);if(count>1000)goto done;
  if(!write_exact(&count,4)){result=5;goto done;}
  SIZE_T total=4;
  for(UINT i=0;i<count;i++){
    UINT length=DragQueryFileW((HDROP)block,i,NULL,0);if(!length||length>32767)goto done;
    uint32_t bytes=length*2;total+=bytes+4;if(total>2u*1024u*1024u)goto done;
    WCHAR* value=HeapAlloc(GetProcessHeap(),0,(length+1)*sizeof(WCHAR));if(!value){result=4;goto done;}
    int ok=DragQueryFileW((HDROP)block,i,value,length+1)==length&&write_exact(&bytes,4)&&write_exact(value,bytes);HeapFree(GetProcessHeap(),0,value);if(!ok)goto done;
  }
  result=0;
done:CloseClipboard();return result;
}
int main(int argc,char** argv){
  if(argc==2&&!strcmp(argv[1],"--read-files"))return read_files();
  if(argc!=1)return 2;
  uint32_t magic=0,count=0;HGLOBAL blocks[8]={0};UINT formats[8]={0};size_t total=0;int result=2;
  if(!read_exact(&magic,4)||magic!=0x50434c54||!read_exact(&count,4)||!count||count>8)goto cleanup;
  for(uint32_t i=0;i<count;i++){
    uint32_t name_size=0,data_size=0;char name[128]={0};
    if(!read_exact(&name_size,4)||!read_exact(&data_size,4)||!name_size||name_size>=sizeof(name)||!data_size)goto cleanup;
    total+=data_size;if(total>512u*1024u*1024u||!read_exact(name,name_size))goto cleanup;
    if(!strcmp(name,"CF_UNICODETEXT"))formats[i]=CF_UNICODETEXT;
    else if(!strcmp(name,"CF_DIBV5"))formats[i]=CF_DIBV5;
    else if(!strcmp(name,"HTML Format")||!strcmp(name,"PNG")||!strcmp(name,"application/x-tde-events")||!strcmp(name,"application/x-todoline-html"))formats[i]=RegisterClipboardFormatA(name);
    else goto cleanup;
    if(!formats[i])goto cleanup;
    blocks[i]=GlobalAlloc(GMEM_MOVEABLE,data_size);if(!blocks[i]){result=4;goto cleanup;}
    void* bytes=GlobalLock(blocks[i]);if(!bytes){result=4;goto cleanup;}
    int ok=read_exact(bytes,data_size);GlobalUnlock(blocks[i]);if(!ok)goto cleanup;
  }
  {
    HWND owner=CreateWindowExW(0,L"STATIC",L"TodoLine Clipboard",0,0,0,0,0,HWND_MESSAGE,NULL,GetModuleHandleW(NULL),NULL);
    if(!owner){result=3;goto cleanup;}
    /* Clipboard viewers may briefly hold the lock; keep the UI asynchronous
       while allowing up to one second before reporting a busy clipboard. */
    int opened=0;for(int retry=0;retry<100;retry++){if(OpenClipboard(owner)){opened=1;break;}Sleep(10);}
    if(!opened){DestroyWindow(owner);result=3;goto cleanup;}
    result=5;
    if(EmptyClipboard()){
      result=0;
      for(uint32_t i=0;i<count;i++){
        if(!SetClipboardData(formats[i],blocks[i])){result=5;break;}
        blocks[i]=NULL; /* Ownership transferred to Windows. */
      }
    }
    CloseClipboard();DestroyWindow(owner);
  }
cleanup:
  for(int i=0;i<8;i++)if(blocks[i])GlobalFree(blocks[i]);
  return result;
}
