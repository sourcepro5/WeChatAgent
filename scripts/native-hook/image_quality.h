#pragma once
// Image download quality control for WeChatAgent native backend.
// mode: 1 = HD original, 2 = mid (500px), 3 = thumbnail (untouched)
bool ImageQualityStart();
void ImageQualitySetMode(int mode);
void ImageQualitySetLocal(long localId, int mode);
int  ImageQualityMode();
long ImageQualityHits();
long ImageQualityMods();
