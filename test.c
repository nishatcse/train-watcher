#include<stdio.h>
int main(){
    int x,y,z;
    scanf("%d%d%d",&x,&y,&z);
    printf("X=%d\n",x);
    printf("Y=%d\n",y);
    printf("Z=%d\n",z);
    float a;
    a=(x+y+z)/3;
    printf("Average is=%f",a);
}