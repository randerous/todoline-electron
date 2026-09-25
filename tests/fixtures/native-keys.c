#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
/* Exercise Windows menu accelerators, which CDP key events need not traverse.
   https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput */
int main(int argc,char**argv){
  if(argc!=4||strlen(argv[3])!=1||!strchr("NSFWO",argv[3][0]))return 2;
  HWND target=(HWND)(uintptr_t)strtoull(argv[1],NULL,10);DWORD expected=strtoul(argv[2],NULL,10),actual=0;GetWindowThreadProcessId(target,&actual);
  if(!IsWindow(target)||!IsWindowVisible(target)||!expected||expected!=actual)return 3;
  SetForegroundWindow(target);for(int i=0;i<50&&GetForegroundWindow()!=target;i++)Sleep(10);
  if(GetForegroundWindow()!=target)return 4;
  const int modifiers[]={VK_CONTROL,VK_SHIFT,VK_MENU,VK_LWIN,VK_RWIN};for(int i=0;i<5;i++)if(GetAsyncKeyState(modifiers[i])&0x8000)return 5;
  INPUT keys[4]={0};for(int i=0;i<4;i++)keys[i].type=INPUT_KEYBOARD;
  keys[0].ki.wVk=VK_CONTROL;keys[1].ki.wVk=(WORD)argv[3][0];keys[2].ki.wVk=(WORD)argv[3][0];keys[2].ki.dwFlags=KEYEVENTF_KEYUP;keys[3].ki.wVk=VK_CONTROL;keys[3].ki.dwFlags=KEYEVENTF_KEYUP;
  if(SendInput(4,keys,sizeof(INPUT))==4)return 0;
  SendInput(2,keys+2,sizeof(INPUT));return 6;
}
