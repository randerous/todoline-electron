#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
/* A separate process briefly holds the system clipboard to exercise contention. */
int main(void){
  HWND owner=CreateWindowExW(0,L"STATIC",L"TodoLine Clipboard Test",0,0,0,0,0,HWND_MESSAGE,NULL,GetModuleHandleW(NULL),NULL);
  if(!owner)return 1;
  int opened=0;for(int i=0;i<100;i++){if(OpenClipboard(owner)){opened=1;break;}Sleep(10);}
  if(!opened){DestroyWindow(owner);return 2;}
  puts("ready");fflush(stdout);Sleep(600);
  CloseClipboard();DestroyWindow(owner);return 0;
}
